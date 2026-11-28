//! Provider probe: what the host shows about Codex without a session (install, version, sign-in,
//! models). Ported from GOAT v1 (origin/dev 916b5ccc) `apps/server/src/provider/`:
//! - `CodexProvider.ts:486-620` (`probeCodexAppServerProvider`): a short-lived app-server,
//!   `initialize` (version from the user agent), `account/read`, then `model/list` (all pages; for
//!   a ChatGPT login after Codex refreshed its catalog, `requestCodexChatGptModels`) and
//!   `config/read` within the probe deadline;
//! - `CodexProvider.ts:622-668` (`probeCodexCliVersion`): `codex --version` when the app-server
//!   cannot be used;
//! - `CodexProvider.ts:730-1000` (`checkCodexProviderStatus`): status, auth and messages;
//! - `CodexProvider.ts:143-276` (`mapCodexModelCapabilities`, `parseCodexModelListResponse`),
//!   `codexModelDefaults.ts`, `CodexModelOptionDefaults.ts`, `CodexProviderAccount.ts`,
//!   `packages/shared/src/model.ts:387-393`, `packages/contracts/src/model.ts:129-134`.
//!
//! Not carried: usage limits, skills, slash commands and the OpenCodex route (GOAT 2's probe
//! result has no field for them) and custom models (host settings).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use goat2_contracts::{
    ModelCapabilities, ProviderOptionChoice, ProviderOptionDescriptor, ProviderProbeResult,
    ServerProviderAuth, ServerProviderAuthStatus, ServerProviderCli, ServerProviderModel,
    ServerProviderState,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::time::{Instant, timeout_at};

use crate::engine::{CodexEngineOptions, base_launch};
use crate::process::{ChildProcess, Launch};
use crate::protocol::client::InitializeParams;
use crate::protocol::methods;
use crate::transport::Connection;

/// v1 `CODEX_AUTH_PROBE_TIMEOUT_MS`: handshake plus account and models can exceed 10 s.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_MARGIN: Duration = Duration::from_millis(250);
const CONFIG_TIMEOUT: Duration = Duration::from_secs(3);
const CATALOG_REFRESH_TIMEOUT: Duration = Duration::from_secs(3);
const CATALOG_REFRESH_POLL: Duration = Duration::from_millis(100);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// v1 `PREFERRED_DEFAULT_CODEX_MODELS`: the first present in model/list is the default.
const PREFERRED_DEFAULT_MODELS: [&str; 3] = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"];

/// Probe the Codex this factory would start.
pub async fn probe(options: &CodexEngineOptions) -> ProviderProbeResult {
    probe_with(options, PROBE_TIMEOUT).await
}

/// v1 CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(2);

/// [probe] with an explicit budget (tests).
pub async fn probe_with(options: &CodexEngineOptions, budget: Duration) -> ProviderProbeResult {
    let checked_at = rfc3339_now();
    let program = options.program.clone();
    let binary_path = resolve_binary(&program, options);
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let deadline = Instant::now() + budget;
    let spawned_at_ms = now_ms();
    let mut launch = base_launch(options, &program, cwd.clone());
    launch.kill_grace = FORCE_KILL_AFTER;
    let mut child = match ChildProcess::spawn(&launch) {
        Ok(child) => child,
        Err(error) if command_missing(&error, binary_path.as_deref(), &cwd) => {
            return failed(
                checked_at,
                false,
                Some(ServerProviderCli::Missing),
                None,
                binary_path,
                could_not_start(&program),
            );
        }
        Err(error) => {
            return failure_after_version(
                options,
                &program,
                &cwd,
                checked_at,
                binary_path,
                format!("Codex app-server provider probe failed: {error}."),
            )
            .await;
        }
    };
    let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
        child.kill_group();
        return failure_after_version(
            options,
            &program,
            &cwd,
            checked_at,
            binary_path,
            "Codex app-server provider probe failed: no stdio.".into(),
        )
        .await;
    };
    let (conn, mut inbound) =
        Connection::start_with(stdin, stdout, None, options.transport.clone());
    // Notifications during the probe carry nothing the probe reports.
    let drain = tokio::spawn(async move { while inbound.recv().await.is_some() {} });
    let outcome = timeout_at(
        deadline,
        discover(
            &conn,
            options,
            &cwd,
            spawned_at_ms,
            deadline - DISCOVERY_MARGIN,
        ),
    )
    .await;
    conn.close_input();
    child.terminate_group().await;
    drain.abort();
    match outcome {
        Err(_) => failed(
            checked_at,
            true,
            None,
            None,
            binary_path,
            "Timed out while checking Codex app-server provider status.".into(),
        ),
        Ok(Err(error)) => {
            failure_after_version(
                options,
                &program,
                &cwd,
                checked_at,
                binary_path,
                format!("Codex app-server provider probe failed: {error}."),
            )
            .await
        }
        Ok(Ok(snapshot)) => from_snapshot(snapshot, options, checked_at, binary_path),
    }
}

/// v1 classifySpawnFailure "missing": not found is also what a vanished cwd or a missing
/// interpreter gives; only a command that cannot be found counts (CodexProvider.ts:655-665).
fn command_missing(error: &std::io::Error, binary_path: Option<&str>, cwd: &Path) -> bool {
    error.kind() == std::io::ErrorKind::NotFound && binary_path.is_none() && cwd.is_dir()
}

/// v1 `CodexAppServerProviderSnapshot`, the parts GOAT 2 reports.
struct Snapshot {
    version: Option<String>,
    account: AccountResponse,
    /// v1 `effectiveBaseUrl`: the endpoint the config Codex read for the cwd selects.
    effective_base_url: Option<String>,
    /// None when the catalog did not arrive within the discovery deadline.
    models: Option<Vec<ServerProviderModel>>,
    /// `config/read` `config` (no cwd); None when unread.
    config: Option<Value>,
}

/// A JSON object decoded as `T`. serde lets a JSON array fill a struct by position (and an
/// internally tagged enum with its tag first); the pinned schema and v1's `Schema.Struct` accept
/// only objects, so every struct the probe checks is read through this.
struct Obj<T>(T);

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Obj<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if !value.is_object() {
            return Err(serde::de::Error::custom("expected an object"));
        }
        serde_json::from_value(value)
            .map(Obj)
            .map_err(serde::de::Error::custom)
    }
}

/// Whether `value` is an object that decodes as `T` (see `Obj`).
fn decodes_as<T: serde::de::DeserializeOwned>(value: &Value) -> Result<(), serde_json::Error> {
    serde_json::from_value::<Obj<T>>(value.clone()).map(|_| ())
}

/// The pinned `InitializeResponse` (schema/codex-0.167.0/v1/InitializeResponse.json): v1 decodes every
/// client response with Codex's schema (packages/effect-codex-app-server/src/client.ts:276-288),
/// so a missing required field fails the probe.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct InitializeResponse {
    user_agent: String,
    codex_home: String,
    platform_family: String,
    platform_os: String,
}

/// `account/read` as the probe reads it, after `AccountResponseShape` accepted the answer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountResponse {
    #[serde(default)]
    account: Option<Value>,
    requires_openai_auth: bool,
}

/// `account/read` checked by the pinned `GetAccountResponse` (schema/codex-0.167.0/v2/
/// GetAccountResponse.json) for what the probe reads, as v1 decodes it (packages/effect-codex-app-server/
/// src/client.ts:276-288): `requiresOpenaiAuth` required, `account` null or one of the tagged variants,
/// a ChatGPT account with `email` present (may be null) and a string `planType`. Written difference
/// (owner decision): any `planType` string and unchecked workspace fields, as v1's older decoder; the
/// 0.167.0 `gcp` account, which v1's decoder predates, is accepted. Unknown fields are tolerated.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct AccountResponseShape {
    account: Option<Obj<AccountShape>>,
    requires_openai_auth: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
enum AccountShape {
    ApiKey {},
    #[serde(rename_all = "camelCase")]
    Chatgpt {
        /// Required, may be null.
        #[serde(deserialize_with = "present_nullable")]
        email: Option<String>,
        plan_type: String,
    },
    #[serde(rename_all = "camelCase")]
    AmazonBedrock {
        #[serde(default)]
        uses_codex_managed_credentials: bool,
    },
    Gcp {},
}

/// A required field whose value may be `null` (absent is an error, unlike a plain `Option`).
fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// `config/read` checked by the pinned `ConfigReadResponse` (schema/codex-0.167.0/v2/
/// ConfigReadResponse.json) for its required fields (`config` object, `origins` with each layer's `name`
/// and `version`) and the typed config fields the probe reads (`model_provider`, `service_tier`). An
/// answer that fails counts as an unread config, as v1's failed decode does. Written difference
/// (owner decision): config fields the probe never reads are not type-checked, so a mistyped
/// unrelated field cannot change the sign-in state. `openai_base_url`, `model_providers` and `features`
/// are not in the pinned schema; v1 reads them leniently and so does the route code.
#[derive(Deserialize)]
#[allow(dead_code)]
struct ConfigReadShape {
    config: Obj<ConfigShape>,
    origins: std::collections::HashMap<String, Obj<ConfigLayerMetadataShape>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ConfigShape {
    model_provider: Option<String>,
    service_tier: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ConfigLayerMetadataShape {
    name: Obj<ConfigLayerSourceShape>,
    version: String,
}

/// The pinned `ConfigLayerSource` variants and their required fields.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
enum ConfigLayerSourceShape {
    PackagedDefaults {
        file: String,
    },
    Mdm {
        domain: String,
        key: String,
    },
    System {
        file: String,
    },
    EnterpriseManaged {
        id: String,
        name: String,
    },
    User {
        file: String,
        #[serde(default)]
        profile: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Project {
        dot_codex_folder: String,
    },
    SessionFlags {},
    LegacyManagedConfigTomlFromFile {
        file: String,
    },
    LegacyManagedConfigTomlFromMdm {},
}

/// The `config` of a `config/read` answer that matches `ConfigReadShape`; `None` otherwise.
fn read_config(answer: Value) -> Option<Value> {
    if !answer.get("config").is_some_and(Value::is_object)
        || !answer.get("origins").is_some_and(Value::is_object)
    {
        return None;
    }
    decodes_as::<ConfigReadShape>(&answer).ok()?;
    answer.get("config").cloned()
}

impl AccountResponse {
    fn account_type(&self) -> Option<&str> {
        self.account.as_ref()?.get("type")?.as_str()
    }
}

async fn discover(
    conn: &Connection,
    options: &CodexEngineOptions,
    cwd: &Path,
    spawned_at_ms: i64,
    discovery_deadline: Instant,
) -> Result<Snapshot, String> {
    let Obj(init): Obj<InitializeResponse> = serde_json::from_value(
        conn.request_value(
            methods::INITIALIZE,
            &InitializeParams::goat(&options.client_version),
        )
        .await
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("initialize answered an unreadable response: {e}"))?;
    conn.notify(methods::INITIALIZED, &Value::Null)
        .map_err(|e| e.to_string())?;
    let version = version_from_user_agent(&init.user_agent);
    // v1 withCodexAppServerClient (CodexProvider.ts:453-461): the effective endpoint from the
    // config Codex reads for this cwd.
    let route_config = conn
        .request_value(
            methods::CONFIG_READ,
            &json!({ "cwd": cwd, "includeLayers": false }),
        )
        .await
        .ok()
        .and_then(read_config);
    let effective_base_url = route_config
        .as_ref()
        .and_then(|c| read_effective_base_url(c, openai_base_url_env(options).as_deref()));
    let account_value = conn
        .request_value("account/read", &json!({}))
        .await
        .map_err(|e| format!("account/read: {e}"))?;
    decodes_as::<AccountResponseShape>(&account_value)
        .map_err(|e| format!("account/read answered an unreadable account: {e}"))?;
    let account: AccountResponse = serde_json::from_value(account_value)
        .map_err(|e| format!("account/read answered an unreadable account: {e}"))?;
    if account.account.is_none()
        && account.requires_openai_auth
        && !routes_away_from_openai(effective_base_url.as_deref())
    {
        return Ok(Snapshot {
            version,
            account,
            effective_base_url,
            models: Some(Vec::new()),
            config: None,
        });
    }
    // v1 runs these together under the discovery deadline (CodexProvider.ts:535-600); the
    // config read has its own 3 s cap.
    let config_read = async {
        timeout_at(
            discovery_deadline.min(Instant::now() + CONFIG_TIMEOUT),
            conn.request_value(methods::CONFIG_READ, &json!({ "includeLayers": false })),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(read_config)
    };
    let model_list = async {
        if account.account_type() == Some("chatgpt") {
            chatgpt_models(
                conn,
                Some(init.codex_home.as_str()),
                spawned_at_ms,
                discovery_deadline,
            )
            .await
        } else {
            deadline_models(conn, discovery_deadline).await
        }
    };
    let (config, models) = tokio::join!(config_read, model_list);
    Ok(Snapshot {
        version,
        account,
        effective_base_url,
        models: models?,
        config,
    })
}

/// The factory's OPENAI_BASE_URL for Codex, else the host's (Codex inherits it).
fn openai_base_url_env(options: &CodexEngineOptions) -> Option<String> {
    options
        .env_set
        .iter()
        .rev()
        .find(|(k, _)| k == "OPENAI_BASE_URL")
        .map(|(_, v)| v.to_string_lossy().into_owned())
        .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
}

/// The catalog within the deadline: `None` when it passed; an error when Codex refused or
/// answered unreadably (v1 propagates it to the failure path; only the deadline makes the
/// catalog absent).
async fn deadline_models(
    conn: &Connection,
    deadline: Instant,
) -> Result<Option<Vec<ServerProviderModel>>, String> {
    match timeout_at(deadline, all_models(conn)).await {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

/// v1 `requestAllCodexModels`: every page of model/list.
/// The pinned codex 0.167.0 `Model` definition (schema/codex-0.167.0/v2/ModelListResponse.json): v1
/// decodes every client response with Codex's schema (packages/effect-codex-app-server/src/
/// client.ts:276-288), so one entry that does not match (a missing or mistyped field, an unknown
/// enum value, an empty reasoning effort) fails the whole catalog instead of thinning it. Unknown
/// fields are tolerated, as there.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ModelShape {
    id: String,
    model: String,
    display_name: String,
    description: String,
    hidden: bool,
    is_default: bool,
    default_reasoning_effort: ReasoningEffort,
    supported_reasoning_efforts: Vec<Obj<ReasoningEffortOptionShape>>,
    #[serde(default)]
    additional_speed_tiers: Vec<String>,
    availability_nux: Option<Obj<AvailabilityNuxShape>>,
    available_access_programs: Option<Obj<AccessProgramsShape>>,
    default_service_tier: Option<String>,
    #[serde(default)]
    input_modalities: Vec<InputModalityShape>,
    model_specialty: Option<String>,
    multi_agent_version: Option<MultiAgentVersionShape>,
    #[serde(default)]
    service_tiers: Vec<Obj<ServiceTierShape>>,
    #[serde(default)]
    supports_personality: bool,
    upgrade: Option<String>,
    upgrade_info: Option<Obj<UpgradeInfoShape>>,
}

/// `ReasoningEffort`: a non-empty string.
#[derive(Deserialize)]
#[serde(try_from = "String")]
struct ReasoningEffort;

impl TryFrom<String> for ReasoningEffort {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            Err("an empty reasoning effort")
        } else {
            Ok(ReasoningEffort)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReasoningEffortOptionShape {
    description: String,
    reasoning_effort: ReasoningEffort,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AvailabilityNuxShape {
    message: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AccessProgramsShape {
    cyber: Vec<CyberAccessProgramShape>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum CyberAccessProgramShape {
    Standard,
    DaybreakBlue,
    DaybreakRed,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum InputModalityShape {
    Text,
    Image,
    Audio,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MultiAgentVersionShape {
    Disabled,
    V1,
    V2,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ServiceTierShape {
    description: String,
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct UpgradeInfoShape {
    migration_markdown: Option<String>,
    model: String,
    model_link: Option<String>,
    retirement_at: Option<i64>,
    upgrade_copy: Option<String>,
}

async fn all_models(conn: &Connection) -> Result<Vec<ServerProviderModel>, String> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let page = conn
            .request_value("model/list", &params)
            .await
            .map_err(|e| format!("model/list: {e}"))?;
        let data = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "model/list answered without data".to_string())?;
        // Every entry must match the pinned schema: a partial catalog is not a catalog.
        for entry in data {
            decodes_as::<ModelShape>(entry)
                .map_err(|e| format!("model/list answered an unreadable model: {e}"))?;
            models.push(
                model_from_codex(entry)
                    .ok_or_else(|| "model/list answered an unreadable model".to_string())?,
            );
        }
        cursor = match page.get("nextCursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(c)) => (!c.is_empty()).then(|| c.clone()),
            Some(_) => return Err("model/list answered an unreadable nextCursor".into()),
        };
        if cursor.is_none() {
            return Ok(models);
        }
    }
}

/// v1 `requestCodexChatGptModels`: Codex tailors the catalog to its client and refreshes it
/// online at startup; wait (bounded) for a `models_cache.json` newer than this process, then list
/// again.
async fn chatgpt_models(
    conn: &Connection,
    codex_home: Option<&str>,
    spawned_at_ms: i64,
    deadline: Instant,
) -> Result<Option<Vec<ServerProviderModel>>, String> {
    let Some(models) = deadline_models(conn, deadline).await? else {
        return Ok(None);
    };
    let Some(home) = codex_home else {
        return Ok(Some(models));
    };
    let cache = Path::new(home).join("models_cache.json");
    let refresh_until = deadline.min(Instant::now() + CATALOG_REFRESH_TIMEOUT);
    loop {
        if cache_fetched_at_ms(&cache).is_some_and(|at| at >= spawned_at_ms) {
            break;
        }
        if Instant::now() + CATALOG_REFRESH_POLL > refresh_until {
            // v1: "Codex did not refresh its model catalog in time; using the cached catalog."
            return Ok(Some(models));
        }
        tokio::time::sleep(CATALOG_REFRESH_POLL).await;
    }
    Ok(Some(
        deadline_models(conn, deadline).await?.unwrap_or(models),
    ))
}

fn cache_fetched_at_ms(path: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    parse_rfc3339_ms(value.get("fetched_at")?.as_str()?)
}

fn from_snapshot(
    snapshot: Snapshot,
    options: &CodexEngineOptions,
    checked_at: String,
    binary_path: Option<String>,
) -> ProviderProbeResult {
    let effective = snapshot.effective_base_url.as_deref();
    let (status, mut auth, message) =
        account_status(&snapshot.account, effective, codex_home_setting(options));
    let config = snapshot.config.as_ref();
    auth.endpoint = codex_endpoint(config, effective);
    let models = snapshot.models.as_ref().map(|models| {
        let models = preferred_default(models.clone());
        let models = configured_service_tier(
            models,
            config
                .and_then(|c| c.get("service_tier"))
                .and_then(Value::as_str),
        );
        configured_cyber_access(models, &snapshot.account, config)
    });
    let (status, message) = match (&models, message) {
        (_, Some(message)) => (status, Some(message)),
        (None, None) => (
            ServerProviderState::Warning,
            Some("Codex did not return its model catalog in time.".to_string()),
        ),
        (Some(_), None) => (status, None),
    };
    ProviderProbeResult {
        installed: true,
        version: snapshot.version,
        installed_version: None,
        cli: Some(ServerProviderCli::Present),
        binary_path,
        status,
        auth,
        models: models.unwrap_or_default(),
        checked_at,
        message,
    }
}

/// v1 `accountProbeStatus` (CodexProviderAccount.ts:133-170).
fn account_status(
    account: &AccountResponse,
    effective_base_url: Option<&str>,
    codex_home: Option<String>,
) -> (ServerProviderState, ServerProviderAuth, Option<String>) {
    if account.account.is_none()
        && account.requires_openai_auth
        && !routes_away_from_openai(effective_base_url)
    {
        let message = match codex_home {
            Some(home) => format!(
                "Codex CLI is not authenticated. Run `codex login` with CODEX_HOME set to {} and try again.",
                serde_json::to_string(&home).unwrap_or(home)
            ),
            None => "Codex CLI is not authenticated. Run `codex login` and try again.".into(),
        };
        return (
            ServerProviderState::Error,
            auth(ServerProviderAuthStatus::Unauthenticated),
            Some(message),
        );
    }
    let mut auth = auth(if account.account.is_some() {
        ServerProviderAuthStatus::Authenticated
    } else {
        ServerProviderAuthStatus::Unknown
    });
    if let Some(a) = &account.account {
        let kind = a.get("type").and_then(Value::as_str);
        auth.auth_type = kind.map(str::to_string);
        auth.label = match kind {
            Some("apiKey") => Some("OpenAI API Key".into()),
            Some("amazonBedrock") => Some("Amazon Bedrock".into()),
            Some("chatgpt") => {
                plan_label(a.get("planType").and_then(Value::as_str)).map(str::to_string)
            }
            _ => None,
        };
        if kind == Some("chatgpt") {
            // v1 `...(authEmail ? { email } : {})` (CodexProviderAccount.ts:145-153): an empty one is omitted.
            auth.email = a
                .get("email")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
                .map(str::to_string);
        }
    }
    (ServerProviderState::Ready, auth, None)
}

fn auth(status: ServerProviderAuthStatus) -> ServerProviderAuth {
    ServerProviderAuth {
        status,
        auth_type: None,
        label: None,
        email: None,
        action: None,
        can_logout: None,
        subscription_sharing: None,
        profile_id: None,
        workspace_id: None,
        endpoint: None,
    }
}

/// v1 `codexPlanLabel`.
fn plan_label(plan: Option<&str>) -> Option<&'static str> {
    Some(match plan? {
        "free" => "ChatGPT Free Subscription",
        "go" => "ChatGPT Go Subscription",
        "plus" => "ChatGPT Plus Subscription",
        "pro" => "ChatGPT Pro 200 Subscription",
        "prolite" => "ChatGPT Pro 100 Subscription",
        "promax" => "ChatGPT Pro 500 Subscription",
        "self_serve_business_prolite" => "ChatGPT Business Premium Subscription",
        "team" | "self_serve_business_usage_based" | "business" => "ChatGPT Business Subscription",
        "ent26" | "enterprise_cbp_automation" | "enterprise_cbp_usage_based" | "enterprise" => {
            "ChatGPT Enterprise Subscription"
        }
        "edu" | "edu_plus" | "edu_pro" => "ChatGPT Edu Subscription",
        "unknown" => "ChatGPT Subscription",
        _ => return None,
    })
}

/// CODEX_HOME the factory sets for Codex, for the sign-in hint.
fn codex_home_setting(options: &CodexEngineOptions) -> Option<String> {
    options
        .env_set
        .iter()
        .rev()
        .find(|(k, _)| k == "CODEX_HOME")
        .map(|(_, v)| v.to_string_lossy().into_owned())
}

/// WHATWG URL parsing (the `url` crate, as v1's `new URL`: percent-decoding, IPv4 forms, IPv6,
/// UTS46/IDNA). `None` where `new URL` throws.
fn parse_url(text: &str) -> Option<url::Url> {
    url::Url::parse(text).ok()
}

/// v1 `url.hostname` (IPv6 keeps its brackets; IDNA hosts are punycode).
fn hostname(url: &url::Url) -> &str {
    url.host_str().unwrap_or("")
}

/// v1 `url.origin`.
fn origin(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

/// v1 `/^https?:$/.test(url.protocol)`.
fn is_http(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// v1 `readEffectiveBaseUrl` (OpenCodexRoute.ts:151-178): configuration wins only where the
/// selected provider's endpoint is actually observable.
fn read_effective_base_url(config: &Value, env_openai_base_url: Option<&str>) -> Option<String> {
    let root = config.as_object()?;
    let provider = match root.get("model_provider") {
        None | Some(Value::Null) => Value::from("openai"),
        Some(v) => v.clone(),
    };
    let selected = provider
        .as_str()
        .and_then(|p| root.get("model_providers")?.get(p))
        .filter(|v| v.is_object());
    let non_null = |v: Option<&Value>| v.filter(|v| !v.is_null()).cloned();
    let configured = non_null(root.get("openai_base_url"))
        .or_else(|| non_null(selected.and_then(|s| s.get("base_url"))));
    let is_openai = provider.as_str() == Some("openai");
    if is_openai
        && let Some(env) = env_openai_base_url
        && configured.as_ref().and_then(Value::as_str) != Some(env)
    {
        return None;
    }
    let base = if is_openai {
        configured.unwrap_or_else(|| Value::from("https://api.openai.com/v1"))
    } else {
        non_null(selected.and_then(|s| s.get("base_url")))?
    };
    let url = parse_url(base.as_str()?)?;
    // `url.username || url.password || url.search || url.hash`: an empty "?" or "#" is "" in JS.
    if !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_string())
}

/// v1 `routesAwayFromOpenAi`.
fn routes_away_from_openai(effective_base_url: Option<&str>) -> bool {
    let Some(url) = effective_base_url.and_then(parse_url) else {
        return false;
    };
    let host = hostname(&url).trim_end_matches('.');
    !host.is_empty()
        && !["openai.com", "chatgpt.com"]
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// v1 `codexRouteBaseUrl`: `Some(None)` is Codex's auth-dependent OpenAI default; `None` a
/// route that cannot be read.
fn route_base_url(config: &Value) -> Option<Option<String>> {
    let root = config.as_object()?;
    let text = |v: Option<&Value>| -> Option<Option<String>> {
        match v {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(s)) => Some(Some(s.clone())),
            Some(_) => None,
        }
    };
    let provider = match root.get("model_provider") {
        None | Some(Value::Null) => "openai".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return None,
    };
    if provider == "openai" {
        return Some(text(root.get("openai_base_url"))?.filter(|s| !s.is_empty()));
    }
    let entry = root.get("model_providers")?.get(&provider)?;
    text(entry.get("base_url"))
}

/// v1 `routesToNativeOpenai`.
fn routes_to_native_openai(config: &Value) -> bool {
    match route_base_url(config) {
        None => false,
        Some(None) => true,
        Some(Some(base)) => parse_url(&base).is_some_and(|u| {
            u.scheme() == "https" && matches!(hostname(&u), "api.openai.com" | "chatgpt.com")
        }),
    }
}

/// v1 `codexCustomEndpoint`: the origin of a custom endpoint Codex sends model requests to.
fn custom_endpoint(config: &Value) -> Option<String> {
    let base = route_base_url(config)??;
    let url = parse_url(&base)?;
    (is_http(&url) && !routes_to_native_openai(config)).then(|| origin(&url))
}

/// v1 `codexEndpoint`: the configured endpoint, else the effective route's when it leaves OpenAI.
fn codex_endpoint(config: Option<&Value>, effective_base_url: Option<&str>) -> Option<String> {
    let custom = config.and_then(custom_endpoint);
    if custom.is_some() || !routes_away_from_openai(effective_base_url) {
        return custom;
    }
    parse_url(effective_base_url?)
        .filter(is_http)
        .map(|u| origin(&u))
}

const REASONING_LABELS: [(&str, &str); 8] = [
    ("none", "None"),
    ("minimal", "Minimal"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
    ("ultra", "Ultra"),
];
const DEFAULT_SERVICE_TIER: &str = "default";

fn label_for(table: &[(&str, &str)], id: &str) -> String {
    table
        .iter()
        .find(|(k, _)| *k == id)
        .map_or_else(|| id.to_string(), |(_, v)| (*v).to_string())
}

/// v1 `codexModelFamily`.
fn model_family(slug: &str) -> &str {
    if slug.starts_with("openai.gpt-") {
        &slug["openai.".len()..]
    } else {
        slug
    }
}

/// v1 `formatCodexModelName`: leading "gpt" -> "GPT", every "-x" -> "-X".
pub fn format_model_name(name: &str) -> String {
    let name = match name.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("gpt") => format!("GPT{}", &name[3..]),
        _ => name.to_string(),
    };
    let mut out = String::with_capacity(name.len());
    let mut after_dash = false;
    for c in name.chars() {
        if after_dash && c.is_ascii_lowercase() {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
        after_dash = c == '-';
    }
    out
}

fn choice(
    id: &str,
    label: String,
    description: Option<String>,
    is_default: bool,
) -> ProviderOptionChoice {
    ProviderOptionChoice {
        id: id.to_string(),
        label,
        description,
        is_default: is_default.then_some(true),
    }
}

fn select(
    id: &str,
    label: &str,
    options: Vec<ProviderOptionChoice>,
    current: Option<String>,
) -> ProviderOptionDescriptor {
    ProviderOptionDescriptor::Select {
        id: id.into(),
        label: label.into(),
        description: None,
        options,
        current_value: current,
        prompt_injected_values: None,
        role: None,
    }
}

/// v1 `parseCodexModelListResponse` + `mapCodexModelCapabilities` for one model/list entry.
pub fn model_from_codex(model: &Value) -> Option<ServerProviderModel> {
    let slug = model.get("model")?.as_str()?.to_string();
    let display = model
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&slug)
        .to_string();
    let mut descriptors = Vec::new();
    // v1 codexDefaultReasoningEffortOverride: gpt-6-astra defaults to medium.
    let default_effort = if model_family(&slug) == "gpt-6-astra" {
        Some("medium")
    } else {
        model.get("defaultReasoningEffort").and_then(Value::as_str)
    };
    let efforts: Vec<&str> = model
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("reasoningEffort").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if !efforts.is_empty() {
        let current = efforts
            .iter()
            .find(|e| Some(**e) == default_effort)
            .map(|e| e.to_string());
        let options = efforts
            .iter()
            .map(|e| {
                choice(
                    e,
                    label_for(&REASONING_LABELS, e),
                    None,
                    Some(*e) == default_effort,
                )
            })
            .collect();
        descriptors.push(select("reasoningEffort", "Reasoning", options, current));
    }
    let tiers: Vec<(String, String, String)> =
        match model.get("serviceTiers").and_then(Value::as_array) {
            Some(t) if !t.is_empty() => t
                .iter()
                .filter_map(|t| {
                    Some((
                        t.get("id")?.as_str()?.to_string(),
                        t.get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        t.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    ))
                })
                .collect(),
            _ => model
                .get("additionalSpeedTiers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(|id| {
                            (
                                id.to_string(),
                                if id == "fast" {
                                    "Fast".into()
                                } else {
                                    id.to_string()
                                },
                                String::new(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        };
    if !tiers.is_empty() {
        let catalog_default = model
            .get("defaultServiceTier")
            .and_then(Value::as_str)
            .filter(|d| tiers.iter().any(|(id, _, _)| id == d));
        let default_tier = catalog_default.unwrap_or(DEFAULT_SERVICE_TIER).to_string();
        let mut options = vec![choice(
            DEFAULT_SERVICE_TIER,
            "Standard".into(),
            None,
            default_tier == DEFAULT_SERVICE_TIER,
        )];
        for (id, name, description) in &tiers {
            let description = if id == "ultrafast" {
                "Even faster, more expensive".to_string()
            } else {
                description.clone()
            };
            options.push(choice(
                id,
                name.clone(),
                (!description.is_empty()).then_some(description),
                *id == default_tier,
            ));
        }
        descriptors.push(select(
            "serviceTier",
            "Service Tier",
            options,
            Some(default_tier),
        ));
    }
    let programs: Vec<&str> = model
        .pointer("/availableAccessPrograms/cyber")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !programs.is_empty() {
        let has_standard = programs.contains(&"standard");
        let default_program = if has_standard {
            "standard"
        } else {
            programs[0]
        };
        let listed: Vec<&str> = if has_standard {
            programs.clone()
        } else {
            std::iter::once("standard")
                .chain(programs.iter().copied())
                .collect()
        };
        let labels = [
            ("standard", "Standard"),
            ("daybreakBlue", "Daybreak Blue"),
            ("daybreakRed", "Daybreak Red"),
        ];
        let options = listed
            .iter()
            .map(|p| choice(p, label_for(&labels, p), None, *p == default_program))
            .collect();
        descriptors.push(select(
            "cyberAccessProgram",
            "Cyber Access",
            options,
            Some(default_program.to_string()),
        ));
    }
    Some(ServerProviderModel {
        slug,
        name: format_model_name(&display),
        short_name: None,
        sub_provider: None,
        aliases: None,
        badge: None,
        is_custom: false,
        is_default: model
            .get("isDefault")
            .and_then(Value::as_bool)
            .filter(|d| *d),
        is_legacy: None,
        supports_text_generation: None,
        capabilities: Some(ModelCapabilities {
            option_descriptors: Some(descriptors),
        }),
    })
}

/// v1 `applyPreferredCodexDefaultModel`.
fn preferred_default(mut models: Vec<ServerProviderModel>) -> Vec<ServerProviderModel> {
    let preferred = PREFERRED_DEFAULT_MODELS.iter().find_map(|family| {
        models
            .iter()
            .find(|m| !m.is_custom && model_family(&m.slug) == *family)
            .map(|m| m.slug.clone())
    });
    if let Some(slug) = preferred {
        for model in &mut models {
            model.is_default = (model.slug == slug).then_some(true);
        }
    }
    models
}

fn map_descriptors(
    models: Vec<ServerProviderModel>,
    mut update: impl FnMut(
        Vec<ProviderOptionDescriptor>,
        &ServerProviderModel,
    ) -> Vec<ProviderOptionDescriptor>,
) -> Vec<ServerProviderModel> {
    models
        .into_iter()
        .map(|mut model| {
            if let Some(descriptors) = model
                .capabilities
                .as_mut()
                .and_then(|c| c.option_descriptors.take())
            {
                let updated = update(descriptors, &model);
                if let Some(c) = model.capabilities.as_mut() {
                    c.option_descriptors = Some(updated);
                }
            }
            model
        })
        .collect()
}

/// v1 `withConfiguredSelectDefault`.
fn with_select_default(
    models: Vec<ServerProviderModel>,
    descriptor_id: &str,
    pick: impl Fn(&[ProviderOptionChoice]) -> Option<String>,
) -> Vec<ServerProviderModel> {
    map_descriptors(models, |descriptors, _| {
        descriptors
            .into_iter()
            .map(|descriptor| match descriptor {
                ProviderOptionDescriptor::Select {
                    id,
                    label,
                    description,
                    options,
                    current_value,
                    prompt_injected_values,
                    role,
                } if id == descriptor_id => {
                    let Some(value) = pick(&options) else {
                        return ProviderOptionDescriptor::Select {
                            id,
                            label,
                            description,
                            options,
                            current_value,
                            prompt_injected_values,
                            role,
                        };
                    };
                    let options = options
                        .into_iter()
                        .map(|mut o| {
                            o.is_default = (o.id == value).then_some(true);
                            o
                        })
                        .collect();
                    ProviderOptionDescriptor::Select {
                        id,
                        label,
                        description,
                        options,
                        current_value: Some(value),
                        prompt_injected_values,
                        role,
                    }
                }
                other => other,
            })
            .collect()
    })
}

/// v1 `applyConfiguredCodexServiceTier`.
fn configured_service_tier(
    models: Vec<ServerProviderModel>,
    tier: Option<&str>,
) -> Vec<ServerProviderModel> {
    let Some(tier) = tier.filter(|t| !t.is_empty()) else {
        return models;
    };
    with_select_default(models, "serviceTier", |options| {
        options
            .iter()
            .find(|o| o.id == tier || (tier == "fast" && o.id == "priority"))
            .map(|o| o.id.clone())
    })
}

/// v1 `CodexCyberAccessConfig` (CodexProvider.ts:97-107): `daybreak` and
/// `features.api_key_cyber_access_programs`, each absent, null or a boolean; other fields tolerated.
#[derive(Deserialize)]
struct CyberAccessConfig {
    #[serde(default)]
    daybreak: Option<bool>,
    #[serde(default)]
    features: Option<Obj<CyberAccessFeatures>>,
}

#[derive(Deserialize)]
struct CyberAccessFeatures {
    #[serde(default)]
    api_key_cyber_access_programs: Option<bool>,
}

/// v1 `applyConfiguredCodexCyberAccess` with the snapshot's daybreak and API-key program flags
/// (CodexProvider.ts:603-608).
fn configured_cyber_access(
    models: Vec<ServerProviderModel>,
    account: &AccountResponse,
    config: Option<&Value>,
) -> Vec<ServerProviderModel> {
    // v1 decodeCodexCyberAccessConfig (CodexProvider.ts:97-107): the two fields are decoded
    // together; a mistyped one drops both (daybreak off, programs not ruled out), as v1 does at
    // CodexProvider.ts:603-617.
    let cyber = config.and_then(|c| {
        serde_json::from_value::<Obj<CyberAccessConfig>>(c.clone())
            .ok()
            .map(|Obj(c)| c)
    });
    let daybreak: Option<bool> =
        config.map(|_| cyber.as_ref().and_then(|c| c.daybreak) == Some(true));
    let programs_unavailable = account.account_type() == Some("apiKey")
        && (config.is_none()
            || cyber
                .as_ref()
                .and_then(|c| c.features.as_ref())
                .and_then(|Obj(f)| f.api_key_cyber_access_programs)
                == Some(false));
    let offered = map_descriptors(models, |descriptors, model| {
        descriptors
            .into_iter()
            .filter_map(|descriptor| match descriptor {
                ProviderOptionDescriptor::Select { ref id, .. } if id == "cyberAccessProgram" => {
                    if model.is_custom || programs_unavailable {
                        return None;
                    }
                    if daybreak.is_some() {
                        return Some(descriptor);
                    }
                    let ProviderOptionDescriptor::Select {
                        id,
                        label,
                        description,
                        options,
                        prompt_injected_values,
                        role,
                        ..
                    } = descriptor
                    else {
                        unreachable!()
                    };
                    let options = options
                        .into_iter()
                        .map(|mut o| {
                            o.is_default = None;
                            o
                        })
                        .collect();
                    Some(ProviderOptionDescriptor::Select {
                        id,
                        label,
                        description,
                        options,
                        current_value: None,
                        prompt_injected_values,
                        role,
                    })
                }
                other => Some(other),
            })
            .collect()
    });
    if daybreak != Some(true) {
        return offered;
    }
    with_select_default(offered, "cyberAccessProgram", |options| {
        ["daybreakBlue", "daybreakRed"]
            .iter()
            .find(|p| options.iter().any(|o| o.id == **p))
            .map(|p| (*p).to_string())
    })
}

fn version_from_user_agent(user_agent: &str) -> Option<String> {
    let after = &user_agent[user_agent.find('/')? + 1..];
    let version: String = after.chars().take_while(|c| !c.is_whitespace()).collect();
    (!version.is_empty()).then_some(version)
}

/// v1 `CODEX_CLI_VERSION_PATTERN`: `codex-cli 0.159.0`, prereleases and builds kept.
pub fn version_from_cli_output(stdout: &str) -> Option<String> {
    // v1 CODEX_CLI_VERSION_PATTERN (CodexProvider.ts:119-120):
    // v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) as a whole word.
    let suffix_char = |c: char| c.is_ascii_alphanumeric() || c == '.' || c == '-';
    stdout.split_whitespace().find_map(|word| {
        let word = word.strip_prefix('v').unwrap_or(word);
        let core_end = word.find(['-', '+']).unwrap_or(word.len());
        let parts: Vec<&str> = word[..core_end].split('.').collect();
        let core = parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        let mut rest = &word[core_end..];
        if let Some(pre) = rest.strip_prefix('-') {
            let end = pre.find('+').unwrap_or(pre.len());
            if end == 0 || !pre[..end].chars().all(suffix_char) {
                return None;
            }
            rest = &pre[end..];
        }
        if let Some(build) = rest.strip_prefix('+') {
            if build.is_empty() || !build.chars().all(suffix_char) {
                return None;
            }
            rest = "";
        }
        (core && rest.is_empty()).then(|| word.to_string())
    })
}

/// v1 `probeCodexCliVersion` then the failure result.
async fn failure_after_version(
    options: &CodexEngineOptions,
    program: &Path,
    cwd: &Path,
    checked_at: String,
    binary_path: Option<String>,
    message: String,
) -> ProviderProbeResult {
    match cli_version(options, program, cwd, binary_path.as_deref()).await {
        Err(()) => failed(
            checked_at,
            false,
            Some(ServerProviderCli::Missing),
            None,
            binary_path,
            could_not_start(program),
        ),
        Ok(Some(version)) => failed(
            checked_at,
            true,
            Some(ServerProviderCli::Present),
            Some(version),
            binary_path,
            message,
        ),
        Ok(None) => failed(checked_at, true, None, None, binary_path, message),
    }
}

/// `codex --version` in its own process group, ended on every outcome (v1 runs it scoped with
/// a forced kill). `Err(())` = the command is missing; `Ok(None)` = no usable answer.
async fn cli_version(
    options: &CodexEngineOptions,
    program: &Path,
    cwd: &Path,
    binary_path: Option<&str>,
) -> Result<Option<String>, ()> {
    let mut launch = Launch::new(program)
        .without_host_identity()
        .arg("--version");
    launch.cwd = Some(cwd.to_path_buf());
    launch.kill_grace = FORCE_KILL_AFTER;
    launch.env_set.extend(options.env_set.iter().cloned());
    let mut child = match ChildProcess::spawn(&launch) {
        Ok(child) => child,
        Err(error) if command_missing(&error, binary_path, cwd) => return Err(()),
        Err(_) => return Ok(None),
    };
    // Nothing is written to it; a program waiting on stdin sees end of input at once.
    drop(child.take_stdin());
    let stdout = child.take_stdout();
    let read = async move {
        let mut out = Vec::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_end(&mut out).await;
        }
        out
    };
    let output = tokio::time::timeout(VERSION_TIMEOUT, read).await;
    let summary = match output {
        Ok(_) => child.shutdown().await,
        Err(_) => child.terminate_group().await,
    };
    let Ok(output) = output else {
        return Ok(None);
    };
    if !summary.status.is_some_and(|s| s.success()) {
        return Ok(None);
    }
    Ok(version_from_cli_output(&String::from_utf8_lossy(&output)))
}

fn could_not_start(program: &Path) -> String {
    let shown = program.display().to_string();
    format!(
        "Could not start Codex CLI (\u{60}{shown}\u{60}). Check Settings → Providers → Codex → Binary path on the server.{}",
        if shown == "codex" {
            " Installing ChatGPT or Codex desktop may not add codex to PATH."
        } else {
            " Make sure the configured executable exists and can be run."
        }
    )
}

fn failed(
    checked_at: String,
    installed: bool,
    cli: Option<ServerProviderCli>,
    version: Option<String>,
    binary_path: Option<String>,
    message: String,
) -> ProviderProbeResult {
    ProviderProbeResult {
        installed,
        version,
        installed_version: None,
        cli,
        binary_path,
        status: ServerProviderState::Error,
        auth: auth(ServerProviderAuthStatus::Unknown),
        models: Vec::new(),
        checked_at,
        message: Some(message),
    }
}

/// The executable the probe runs: the path as given when it has a directory, else the first
/// match on PATH (the factory's PATH override first).
fn resolve_binary(program: &Path, options: &CodexEngineOptions) -> Option<String> {
    if program.components().count() > 1 {
        return program.is_file().then(|| program.display().to_string());
    }
    let path = options
        .env_set
        .iter()
        .rev()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var_os("PATH"))?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable(candidate))
        .map(|p: PathBuf| p.display().to_string())
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RFC 3339 UTC with milliseconds, as v1 `DateTime.formatIso`.
pub fn rfc3339_now() -> String {
    format_rfc3339_ms(now_ms())
}

pub fn format_rfc3339_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM)` to epoch milliseconds; anything else (impossible
/// dates, bad offsets, trailing text) is None.
pub fn parse_rfc3339_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |s: usize, n: usize| -> Option<i64> {
        let part = text.get(s..s + n)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let (y, mo, d, h, mi, s) = (
        num(0, 4)?,
        num(5, 2)?,
        num(8, 2)?,
        num(11, 2)?,
        num(14, 2)?,
        num(17, 2)?,
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo)
        || d < 1
        || d > month_days[(mo - 1) as usize]
        || h > 23
        || mi > 59
        || s > 59
    {
        return None;
    }
    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let padded: String = text[start..i]
            .chars()
            .chain(std::iter::repeat('0'))
            .take(3)
            .collect();
        millis = padded.parse::<i64>().ok()?;
    }
    let offset_min = match *b.get(i)? {
        b'Z' | b'z' => {
            i += 1;
            0
        }
        sign @ (b'+' | b'-') => {
            if b.get(i + 3) != Some(&b':') {
                return None;
            }
            let (oh, om) = (num(i + 1, 2)?, num(i + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            i += 6;
            if sign == b'+' {
                oh * 60 + om
            } else {
                -(oh * 60 + om)
            }
        }
        _ => return None,
    };
    if i != b.len() {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + s) - offset_min * 60) * 1000 + millis)
}

// Howard Hinnant's civil calendar algorithms.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_round_trips() {
        assert_eq!(format_rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339_ms(1_795_872_371_052),
            "2026-11-28T13:26:11.052Z"
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-28T13:26:11.052Z"),
            Some(1_795_872_371_052)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-28T22:26:11.052+09:00"),
            Some(1_795_872_371_052)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-28T13:26:11.052123Z"),
            Some(1_795_872_371_052)
        );
        assert_eq!(parse_rfc3339_ms("not a time"), None);
    }

    #[test]
    fn versions() {
        assert_eq!(
            version_from_user_agent("codex_cli_rs/0.167.0 (Mac OS 26.1.0; arm64) vscode/1.0"),
            Some("0.167.0".into())
        );
        assert_eq!(
            version_from_cli_output("codex-cli 0.167.0\n"),
            Some("0.167.0".into())
        );
        assert_eq!(
            version_from_cli_output("codex-cli 0.160.0-alpha.1"),
            Some("0.160.0-alpha.1".into())
        );
        assert_eq!(
            version_from_cli_output("0.1.4161006"),
            Some("0.1.4161006".into())
        );
        assert_eq!(version_from_cli_output("no version here"), None);
        // v1's pattern: non-empty suffixes of [0-9A-Za-z.-] only.
        for bad in [
            "1.2.3-",
            "1.2.3+",
            "1.2.3-a_b",
            "1.2.3+x+y",
            "1.2.3-a+",
            "1.2",
        ] {
            assert_eq!(version_from_cli_output(bad), None, "{bad}");
        }
        assert_eq!(
            version_from_cli_output("codex v0.168.0-rc.1+build-7 extra"),
            Some("0.168.0-rc.1+build-7".into())
        );
    }

    #[test]
    fn names_and_endpoints() {
        assert_eq!(format_model_name("gpt-6.1-terra"), "GPT-6.1-Terra");
        assert_eq!(format_model_name("o3-mini"), "o3-Mini");
        assert_eq!(custom_endpoint(&json!({})), None);
        assert_eq!(
            custom_endpoint(&json!({"openai_base_url": "https://api.openai.com/v1"})),
            None
        );
        assert_eq!(
            custom_endpoint(&json!({"openai_base_url": "http://127.0.0.1:8080/v1"})),
            Some("http://127.0.0.1:8080".into())
        );
        assert_eq!(
            custom_endpoint(
                &json!({"model_provider": "azure", "model_providers": {"azure": {"base_url": "https://x.example.com/openai"}}})
            ),
            Some("https://x.example.com".into())
        );
    }
    #[test]
    fn account_answers_follow_the_pinned_schema() {
        let ok = |v: Value| decodes_as::<AccountResponseShape>(&v).is_ok();
        // Accepted: no account, each variant, a ChatGPT email that is null, defaulted and
        // nullable fields absent, complete workspace routing, unknown fields.
        for good in [
            json!({"account": null, "requiresOpenaiAuth": true}),
            json!({"requiresOpenaiAuth": false}),
            json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "email": null, "planType": "pro"}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "email": "a@b.c", "planType": "unknown", "workspaceName": "W"}, "requiresOpenaiAuth": true, "future": 1}),
            json!({"account": {"type": "amazonBedrock"}, "requiresOpenaiAuth": false}),
            json!({"account": {"type": "gcp"}, "requiresOpenaiAuth": false}),
            json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true, "workspaceRouting": {"accountRoutingOverride": "us_cr", "backendOrigin": "https://x", "chatgptAccountId": "id"}}),
            // v1's leniency where the value is unused (owner decision): any plan, workspace
            // fields unchecked.
            json!({"account": {"type": "chatgpt", "email": null, "planType": "galaxy", "workspaceName": 7}, "requiresOpenaiAuth": true}),
            json!({"account": null, "requiresOpenaiAuth": true, "workspaceRouting": {"backendOrigin": "x"}}),
        ] {
            assert!(ok(good.clone()), "{good}");
        }
        for bad in [
            json!({"account": {"type": "apiKey"}}),
            json!({"account": {}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "planType": "pro"}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "email": "a@b.c"}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "email": 3, "planType": "pro"}, "requiresOpenaiAuth": true}),
            json!({"account": {"type": "amazonBedrock", "usesCodexManagedCredentials": null}, "requiresOpenaiAuth": true}),
            json!({"account": "apiKey", "requiresOpenaiAuth": true}),
            json!({"account": {"type": "chatgpt", "email": null, "planType": 3}, "requiresOpenaiAuth": true}),
            json!({"account": ["apiKey"], "requiresOpenaiAuth": true}),
            json!({"account": ["chatgpt", null, "pro"], "requiresOpenaiAuth": true}),
            json!([null, true]),
        ] {
            assert!(!ok(bad.clone()), "{bad}");
        }
        // v1 omits an empty ChatGPT email (CodexProviderAccount.ts:145-153).
        let email = |e: Value| {
            let a: AccountResponse = serde_json::from_value(
                json!({"account": {"type": "chatgpt", "email": e, "planType": "pro"}, "requiresOpenaiAuth": true}),
            )
            .unwrap();
            account_status(&a, None, None).1.email
        };
        assert_eq!(email(json!("")), None);
        assert_eq!(email(json!("a@b.c")).as_deref(), Some("a@b.c"));
    }

    /// Final review r3: v1 decodes `daybreak` and `features.api_key_cyber_access_programs` together
    /// (CodexProvider.ts:97-107,603-617); a mistyped one drops both.
    #[test]
    fn cyber_access_config_is_decoded_as_one_as_v1() {
        let model = model_from_codex(
            &json!({"id": "m", "model": "m", "displayName": "m", "description": "",
            "hidden": false, "isDefault": true, "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": ""}],
            "availableAccessPrograms": {"cyber": ["standard", "daybreakBlue"]}}),
        )
        .unwrap();
        let account = |kind: &str| -> AccountResponse {
            serde_json::from_value(json!({"account": {"type": kind, "email": null, "planType": "pro"}, "requiresOpenaiAuth": true})).unwrap()
        };
        let cyber = |account: &AccountResponse, config: Value| {
            configured_cyber_access(vec![model.clone()], account, Some(&config))
                .into_iter()
                .next()
                .and_then(|m| m.capabilities?.option_descriptors)
                .and_then(|d| {
                    d.into_iter().find_map(|d| match d {
                        ProviderOptionDescriptor::Select {
                            id, current_value, ..
                        } if id == "cyberAccessProgram" => Some(current_value),
                        _ => None,
                    })
                })
        };
        // Daybreak off with the config read keeps the model's own default (v1).
        let standard = || Some(Some("standard".to_string()));
        let chatgpt = account("chatgpt");
        assert_eq!(
            cyber(&chatgpt, json!({"daybreak": true})),
            Some(Some("daybreakBlue".to_string()))
        );
        // A mistyped feature flag next to it: v1's decode fails, daybreak counts as off.
        assert_eq!(
            cyber(
                &chatgpt,
                json!({"daybreak": true, "features": {"api_key_cyber_access_programs": "no"}})
            ),
            standard()
        );
        assert_eq!(cyber(&chatgpt, json!({"daybreak": "yes"})), standard());
        assert_eq!(
            cyber(&chatgpt, json!({"daybreak": null, "features": null})),
            standard()
        );
        // An API key with the programs turned off hides the option; a mistyped flag does not.
        let api_key = account("apiKey");
        assert_eq!(
            cyber(
                &api_key,
                json!({"features": {"api_key_cyber_access_programs": false}})
            ),
            None
        );
        assert_eq!(
            cyber(
                &api_key,
                json!({"features": {"api_key_cyber_access_programs": 0}})
            ),
            standard()
        );
        assert_eq!(cyber(&api_key, json!({"features": []})), standard());
        // Final review r4: a positional features array is not the features object.
        assert_eq!(cyber(&api_key, json!({"features": [false]})), standard());
        assert_eq!(
            cyber(&chatgpt, json!({"daybreak": true, "features": [false]})),
            standard()
        );
        assert_eq!(cyber(&chatgpt, json!([true, null])), standard());
    }

    #[test]
    fn config_answers_follow_the_pinned_schema() {
        let origins =
            json!({"model": {"name": {"type": "user", "file": "/x/config.toml"}, "version": "v1"}});
        let read = |v: Value| read_config(v);
        assert_eq!(
            read(
                json!({"config": {"model_provider": "azure", "service_tier": null, "approval_policy": 5}, "origins": origins})
            ),
            Some(json!({"model_provider": "azure", "service_tier": null, "approval_policy": 5}))
        );
        assert!(read(json!({"config": {}, "origins": {}, "layers": null})).is_some());
        for bad in [
            json!({"config": {"model_provider": "azure"}}),
            json!({"origins": {}}),
            json!({"config": [null, null], "origins": {}}),
            json!({"config": {}, "origins": []}),
            json!({"config": {"model_provider": 3}, "origins": {}}),
            json!({"config": {"service_tier": true}, "origins": {}}),
            json!({"config": {}, "origins": {"model": {"version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": {}, "version": 1}}}),
            // Final review r4: each origin's source is a pinned ConfigLayerSource object.
            json!({"config": {}, "origins": {"model": {"name": null, "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": 7, "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": {"type": "user"}, "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": {"type": "nope"}, "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": ["sessionFlags"], "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": [{"type": "sessionFlags"}, "v1"]}}),
            json!({"config": {}, "origins": {"model": {"name": {"type": "project", "dot_codex_folder": "/p"}, "version": "v1"}}}),
            json!({"config": {}, "origins": {"model": {"name": {"type": "mdm", "domain": "d"}, "version": "v1"}}}),
            json!({"config": ["azure", null], "origins": {}}),
        ] {
            assert_eq!(read(bad.clone()), None, "{bad}");
        }
        for source in [
            json!({"type": "packagedDefaults", "file": "/a"}),
            json!({"type": "mdm", "domain": "d", "key": "k"}),
            json!({"type": "system", "file": "/a"}),
            json!({"type": "enterpriseManaged", "id": "i", "name": "n"}),
            json!({"type": "user", "file": "/a", "profile": null}),
            json!({"type": "project", "dotCodexFolder": "/p/.codex"}),
            json!({"type": "sessionFlags"}),
            json!({"type": "legacyManagedConfigTomlFromFile", "file": "/a"}),
            json!({"type": "legacyManagedConfigTomlFromMdm"}),
        ] {
            assert!(
                read(json!({"config": {}, "origins": {"k": {"name": source, "version": "v"}}}))
                    .is_some(),
                "{source}"
            );
        }
    }

    #[test]
    fn urls_follow_whatwg_origins() {
        // Every expected value below was checked against Node's `new URL` (v1's parser).
        let o = |text: &str| parse_url(text).map(|u| origin(&u));
        assert_eq!(
            o("HTTPS://API.Example.com:443/v1/").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(
            o("http://127.0.0.1:80").as_deref(),
            Some("http://127.0.0.1")
        );
        assert_eq!(
            o("http://[::1]:8080/x").as_deref(),
            Some("http://[::1]:8080")
        );
        for invalid in [
            "http://host:99999",
            "http://:80",
            "not a url",
            "http://[::1]x",
            "http://[::::]/",
            "http://[1:2:3]/",
            "http://1.2.3.256/",
            "http://1.2.3.4.5/",
            "http://a%2fb/",
            "http://a%zz/",
        ] {
            assert_eq!(o(invalid), None, "{invalid}");
        }
        assert_eq!(parse_url("https://u:p@h/").unwrap().username(), "u");
        // Percent-encoded and dotted OpenAI hosts are still OpenAI.
        assert_eq!(
            o("https://%61pi.openai.com/v1").as_deref(),
            Some("https://api.openai.com")
        );
        assert!(!routes_away_from_openai(Some(
            "https://%61pi.openai.com/v1"
        )));
        assert!(!routes_away_from_openai(Some("https://API.OPENAI.COM./v1")));
        assert_eq!(
            o("http://[0:0:0:0:0:0:0:1]:443/").as_deref(),
            Some("http://[::1]:443")
        );
        assert_eq!(hostname(&parse_url("http://[::1]/").unwrap()), "[::1]");
        // IPv4 number forms.
        assert_eq!(o("http://0x7f.1/").as_deref(), Some("http://127.0.0.1"));
        assert_eq!(
            o("http://017700000001/").as_deref(),
            Some("http://127.0.0.1")
        );
        assert_eq!(
            o("http://2130706433:8080/").as_deref(),
            Some("http://127.0.0.1:8080")
        );
        // UTS46/IDNA: an internationalized host is punycode and away from OpenAI; fullwidth and
        // other mapped spellings of an OpenAI host are OpenAI.
        assert_eq!(
            o("https://bücher.example/v1").as_deref(),
            Some("https://xn--bcher-kva.example")
        );
        assert!(routes_away_from_openai(Some("https://bücher.example/v1")));
        assert_eq!(
            o("https://ａpi.openai.com/v1").as_deref(),
            Some("https://api.openai.com")
        );
        assert!(!routes_away_from_openai(Some("https://ａpi.openai.com/v1")));
        assert!(!routes_away_from_openai(Some(
            "https://ＡＰＩ．ＯＰＥＮＡＩ．ＣＯＭ/v1"
        )));
        assert!(!routes_away_from_openai(Some("https://chatgpt。com/x")));
        assert_eq!(
            o("https://xn--bcher-kva.example/").as_deref(),
            Some("https://xn--bcher-kva.example")
        );
        assert_eq!(
            codex_endpoint(None, Some("https://bücher.example/v1")).as_deref(),
            Some("https://xn--bcher-kva.example")
        );
        // Effective base URL is `url.toString()` without trailing slashes, as v1.
        assert_eq!(
            read_effective_base_url(
                &json!({"openai_base_url": "https://bücher.example/v1/"}),
                None
            )
            .as_deref(),
            Some("https://xn--bcher-kva.example/v1")
        );
        assert_eq!(
            read_effective_base_url(&json!({"openai_base_url": "https://h/v1?"}), None).as_deref(),
            Some("https://h/v1?")
        );
        assert_eq!(
            read_effective_base_url(&json!({"openai_base_url": "https://u@h/v1"}), None),
            None
        );
        assert_eq!(
            read_effective_base_url(&json!({"openai_base_url": "https://h/v1#x"}), None),
            None
        );
    }

    #[test]
    fn effective_base_url_follows_v1() {
        assert_eq!(
            read_effective_base_url(&json!({}), None).as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            read_effective_base_url(
                &json!({"openai_base_url": "http://127.0.0.1:9999/v1/"}),
                None
            )
            .as_deref(),
            Some("http://127.0.0.1:9999/v1")
        );
        // An OPENAI_BASE_URL the config does not match makes the route unobservable.
        assert_eq!(
            read_effective_base_url(&json!({}), Some("http://x/v1")),
            None
        );
        assert_eq!(
            read_effective_base_url(&json!({"model_provider": "azure", "model_providers": {"azure": {"base_url": "https://a.example.com/o"}}}), None).as_deref(),
            Some("https://a.example.com/o")
        );
        assert_eq!(
            read_effective_base_url(&json!({"openai_base_url": "https://h/v1?k=1"}), None),
            None
        );
        assert!(!routes_away_from_openai(Some("https://api.openai.com/v1")));
        assert!(!routes_away_from_openai(Some("https://eu.chatgpt.com/x")));
        assert!(routes_away_from_openai(Some("http://127.0.0.1:9999/v1")));
        assert!(!routes_away_from_openai(None));
        assert_eq!(
            codex_endpoint(None, Some("http://127.0.0.1:9999/v1")).as_deref(),
            Some("http://127.0.0.1:9999")
        );
        assert_eq!(
            codex_endpoint(None, Some("https://api.openai.com/v1")),
            None
        );
    }

    #[test]
    fn timestamps_are_validated() {
        for bad in [
            "2026-02-30T00:00:00Z",
            "2026-11-28T25:00:00Z",
            "2026-11-28T13:26:11Zjunk",
            "2026-11-28T13:26:11+0900",
            "2026-11-28T13:26:11+24:00",
            "2026-11-28T13:26:11.Z",
            "2026-13-01T00:00:00Z",
        ] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad}");
        }
        assert!(parse_rfc3339_ms("2024-02-29T00:00:00Z").is_some());
    }

    #[test]
    fn model_names_never_split_a_character() {
        assert_eq!(format_model_name("éé-x"), "éé-X");
        assert_eq!(format_model_name("Gé"), "Gé");
        assert_eq!(format_model_name("GPT"), "GPT");
    }
}

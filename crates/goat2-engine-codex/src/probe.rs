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
use tokio::time::{Instant, timeout_at};

use crate::engine::{CodexEngineOptions, base_launch};
use crate::process::ChildProcess;
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

/// [probe] with an explicit budget (tests).
pub async fn probe_with(options: &CodexEngineOptions, budget: Duration) -> ProviderProbeResult {
    let checked_at = rfc3339_now();
    let program = options.program.clone();
    let binary_path = resolve_binary(&program, options);
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let deadline = Instant::now() + budget;
    let spawned_at_ms = now_ms();
    let mut launch = base_launch(options, &program, cwd.clone());
    launch.kill_grace = Duration::from_secs(2); // v1 CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER
    let mut child = match ChildProcess::spawn(&launch) {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
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
        discover(&conn, options, spawned_at_ms, deadline - DISCOVERY_MARGIN),
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

/// v1 `CodexAppServerProviderSnapshot`, the parts GOAT 2 reports.
struct Snapshot {
    version: Option<String>,
    account: AccountResponse,
    /// None when the catalog did not arrive in time.
    models: Option<Vec<ServerProviderModel>>,
    /// `config/read` `config`; None when unread.
    config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeResponse {
    #[serde(default)]
    user_agent: String,
    #[serde(default)]
    codex_home: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountResponse {
    #[serde(default)]
    account: Option<Value>,
    #[serde(default)]
    requires_openai_auth: bool,
}

impl AccountResponse {
    fn account_type(&self) -> Option<&str> {
        self.account.as_ref()?.get("type")?.as_str()
    }
}

async fn discover(
    conn: &Connection,
    options: &CodexEngineOptions,
    spawned_at_ms: i64,
    discovery_deadline: Instant,
) -> Result<Snapshot, String> {
    let init: InitializeResponse = conn
        .request(
            methods::INITIALIZE,
            &InitializeParams::goat(&options.client_version),
        )
        .await
        .map_err(|e| e.to_string())?;
    conn.notify(methods::INITIALIZED, &Value::Null)
        .map_err(|e| e.to_string())?;
    let version = version_from_user_agent(&init.user_agent);
    let account: AccountResponse = conn
        .request("account/read", &json!({}))
        .await
        .map_err(|e| e.to_string())?;
    if account.account.is_none() && account.requires_openai_auth {
        return Ok(Snapshot {
            version,
            account,
            models: Some(Vec::new()),
            config: None,
        });
    }
    // Optional discovery finishes before the outer deadline can discard the account result.
    let config = timeout_at(
        discovery_deadline.min(Instant::now() + CONFIG_TIMEOUT),
        conn.request_value(methods::CONFIG_READ, &json!({ "includeLayers": false })),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|v| v.get("config").cloned());
    let models = if account.account_type() == Some("chatgpt") {
        chatgpt_models(
            conn,
            init.codex_home.as_deref(),
            spawned_at_ms,
            discovery_deadline,
        )
        .await
    } else {
        timeout_at(discovery_deadline, all_models(conn))
            .await
            .ok()
            .flatten()
    };
    Ok(Snapshot {
        version,
        account,
        models,
        config,
    })
}

/// v1 `requestAllCodexModels`: every page of model/list.
async fn all_models(conn: &Connection) -> Option<Vec<ServerProviderModel>> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let page = conn.request_value("model/list", &params).await.ok()?;
        let data = page.get("data")?.as_array()?;
        models.extend(data.iter().filter_map(model_from_codex));
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            return Some(models);
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
) -> Option<Vec<ServerProviderModel>> {
    let models = timeout_at(deadline, all_models(conn))
        .await
        .ok()
        .flatten()?;
    let Some(home) = codex_home else {
        return Some(models);
    };
    let cache = Path::new(home).join("models_cache.json");
    let refresh_until = deadline.min(Instant::now() + CATALOG_REFRESH_TIMEOUT);
    loop {
        if cache_fetched_at_ms(&cache).is_some_and(|at| at >= spawned_at_ms) {
            break;
        }
        if Instant::now() + CATALOG_REFRESH_POLL > refresh_until {
            // v1: "Codex did not refresh its model catalog in time; using the cached catalog."
            return Some(models);
        }
        tokio::time::sleep(CATALOG_REFRESH_POLL).await;
    }
    Some(
        timeout_at(deadline, all_models(conn))
            .await
            .ok()
            .flatten()
            .unwrap_or(models),
    )
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
    let (status, mut auth, message) =
        account_status(&snapshot.account, codex_home_setting(options));
    let config = snapshot.config.as_ref();
    if let Some(endpoint) = config.and_then(custom_endpoint) {
        auth.endpoint = Some(endpoint);
    }
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

/// v1 `accountProbeStatus` (CodexProviderAccount.ts:133-170), without the OpenCodex route.
fn account_status(
    account: &AccountResponse,
    codex_home: Option<String>,
) -> (ServerProviderState, ServerProviderAuth, Option<String>) {
    if account.account.is_none() && account.requires_openai_auth {
        let message = match codex_home {
            Some(home) => format!(
                "Codex CLI is not authenticated. Run \u{60}codex login\u{60} with CODEX_HOME set to {} and try again.",
                serde_json::to_string(&home).unwrap_or(home)
            ),
            None => {
                "Codex CLI is not authenticated. Run \u{60}codex login\u{60} and try again.".into()
            }
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
            auth.email = a.get("email").and_then(Value::as_str).map(str::to_string);
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

/// v1 `codexCustomEndpoint`: the origin of a custom endpoint Codex sends model requests to.
fn custom_endpoint(config: &Value) -> Option<String> {
    let provider = config
        .get("model_provider")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let base = if provider == "openai" {
        config
            .get("openai_base_url")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?
    } else {
        config
            .get("model_providers")?
            .get(provider)?
            .get("base_url")?
            .as_str()?
    };
    let (scheme, rest) = base.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|a| !a.is_empty())?;
    let host = authority.rsplit('@').next()?.to_ascii_lowercase();
    let hostname = host.split(':').next().unwrap_or("");
    let native = scheme == "https" && (hostname == "api.openai.com" || hostname == "chatgpt.com");
    (!native).then(|| format!("{scheme}://{host}"))
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
    let name = if name.len() >= 3 && name[..3].eq_ignore_ascii_case("gpt") {
        format!("GPT{}", &name[3..])
    } else {
        name.to_string()
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

/// v1 `applyConfiguredCodexCyberAccess` with the snapshot's daybreak and API-key program flags
/// (CodexProvider.ts:603-608).
fn configured_cyber_access(
    models: Vec<ServerProviderModel>,
    account: &AccountResponse,
    config: Option<&Value>,
) -> Vec<ServerProviderModel> {
    let daybreak: Option<bool> =
        config.map(|c| c.get("daybreak").and_then(Value::as_bool) == Some(true));
    let programs_unavailable = account.account_type() == Some("apiKey")
        && config.is_none_or(|c| {
            c.pointer("/features/api_key_cyber_access_programs")
                .and_then(Value::as_bool)
                == Some(false)
        });
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
    stdout.split_whitespace().find_map(|word| {
        let word = word.strip_prefix('v').unwrap_or(word);
        let core_end = word.find(['-', '+']).unwrap_or(word.len());
        let parts: Vec<&str> = word[..core_end].split('.').collect();
        (parts.len() == 3
            && parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        .then(|| word.to_string())
    })
}

/// v1 `probeCodexCliVersion` then the failure result: `None` = no answer, `Err` = missing.
async fn failure_after_version(
    options: &CodexEngineOptions,
    program: &Path,
    cwd: &Path,
    checked_at: String,
    binary_path: Option<String>,
    message: String,
) -> ProviderProbeResult {
    match cli_version(options, program, cwd).await {
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

async fn cli_version(
    options: &CodexEngineOptions,
    program: &Path,
    cwd: &Path,
) -> Result<Option<String>, ()> {
    let mut command = tokio::process::Command::new(program);
    command.arg("--version").current_dir(cwd).kill_on_drop(true);
    for (k, v) in &options.env_set {
        command.env(k, v);
    }
    let output = match tokio::time::timeout(VERSION_TIMEOUT, command.output()).await {
        Err(_) => return Ok(None),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => return Err(()),
        Ok(Err(_)) => return Ok(None),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        return Ok(None);
    }
    Ok(version_from_cli_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
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

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM)` to epoch milliseconds.
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
        || !matches!(b[10], b'T' | b't' | b' ')
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
    let mut i = 19;
    let mut millis = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        let frac = &text[start..i];
        let padded: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
        millis = padded.parse::<i64>().ok()?;
    }
    let offset_min = match b.get(i)? {
        b'Z' | b'z' => 0,
        sign @ (b'+' | b'-') => {
            let oh = num(i + 1, 2)?;
            let om = num(i + 4, 2)?;
            let total = oh * 60 + om;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
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
}

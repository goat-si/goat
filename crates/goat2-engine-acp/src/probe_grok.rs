//! Grok status, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2)
//! `packages/provider-grok/src/server/status.ts` (`checkGrokProviderStatus` :403-623, models and
//! reasoning options :119-297), `probeEnvironment.ts` (`grokProbeEnvironment`), `auth.ts:20`
//! (`XAI_API_KEY`) and `acpSupport.ts:133-144,248-260` (spawn args, base model id, effort tokens).
//!
//! v1 reads `grok --version` and `grok models`, then an ACP `initialize` only: never `authenticate`
//! or `session/new`, so the check cannot open a browser login or boot workspace MCP servers.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use goat2_contracts::{
    ModelCapabilities, ProviderOptionChoice, ProviderOptionDescriptor, ProviderProbeResult,
    ServerProviderAuth, ServerProviderAuthStatus, ServerProviderCli, ServerProviderModel,
    ServerProviderState,
};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::support::{
    AUTH_PROBE_TIMEOUT_MS, SpawnFailure, auth_status, built_in_model, child_environment,
    classify_spawn_failure, create_model_capabilities, empty_capabilities, instance_environment,
    parse_cli_version_result, probe_homes, provider_models_from_settings, resolve_executable,
    resolve_provider_probe_timeout, safe_process_cwd, spawn_and_collect,
    spawn_failure_message_with_homes, with_login_shell_path_note,
};
use super::{ProbeConfig, checked_at_now, effective_command};
use crate::engine::AcpEngineFactory;
use crate::registry::settings::CustomModelSetting as CustomModel;

/// v1 status.ts:67-71: Grok writes its initialize result after startup work that measured 9-14 s.
pub const VERSION_PROBE_TIMEOUT_MS: u64 = 10_000;
pub const GROK_ACP_INITIALIZE_TIMEOUT_MS: u64 = 20_000;
/// v1 acpSupport.ts:248.
pub const GROK_DEFAULT_MODEL_SLUG: &str = "grok-build";
/// v1 auth.ts:20.
pub const GROK_API_KEY_ENV: &str = "XAI_API_KEY";
/// v1 status.ts:134.
const GROK_EFFORT_RANK: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// v1 `resolveGrokAcpBaseModelId` (acpSupport.ts:250-254); Grok has no model slug aliases.
pub fn resolve_grok_base_model_id(model: Option<&str>) -> String {
    match model.map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => trimmed.to_owned(),
        _ => GROK_DEFAULT_MODEL_SLUG.to_owned(),
    }
}

/// v1 `isValidGrokReasoningEffortToken` (acpSupport.ts:256-260).
pub fn is_valid_reasoning_effort_token(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && value.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// v1 `GROK_BUILT_IN_MODELS` (status.ts:73-80).
fn built_in_models() -> Vec<ServerProviderModel> {
    let mut model = built_in_model(GROK_DEFAULT_MODEL_SLUG, "Grok Build");
    model.capabilities = Some(empty_capabilities());
    vec![model]
}

/// v1 `grokModelsFromSettings` (status.ts:119-124).
fn grok_models_from_settings(
    custom: &[CustomModel],
    built_in: Vec<ServerProviderModel>,
) -> Vec<ServerProviderModel> {
    provider_models_from_settings(built_in, custom, Some(empty_capabilities()))
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// v1 `grokReasoningOptionsFromModel` (status.ts:136-206): (options, currentValue).
pub fn grok_reasoning_options(meta: Option<&Value>) -> (Vec<ProviderOptionChoice>, Option<String>) {
    let Some(meta) = meta.filter(|m| m.is_object()) else {
        return (Vec::new(), None);
    };
    if meta.get("supportsReasoningEffort") == Some(&Value::Bool(false)) {
        return (Vec::new(), None);
    }
    let current_effort = non_empty(meta.get("reasoningEffort"));
    let mut seen = HashSet::new();
    let mut options: Vec<(ProviderOptionChoice, bool)> = Vec::new();
    for entry in meta
        .get("reasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !entry.is_object() {
            continue;
        }
        let raw_value = non_empty(entry.get("value"));
        let raw_id = non_empty(entry.get("id"));
        let value = raw_value
            .filter(|v| is_valid_reasoning_effort_token(v))
            .or(raw_id.filter(|v| is_valid_reasoning_effort_token(v)));
        let Some(value) = value else { continue };
        if !seen.insert(value.clone()) {
            continue;
        }
        options.push((
            ProviderOptionChoice {
                label: non_empty(entry.get("label")).unwrap_or_else(|| value.clone()),
                description: non_empty(entry.get("description")),
                id: value,
                is_default: None,
            },
            entry.get("default") == Some(&Value::Bool(true))
                || entry.get("isDefault") == Some(&Value::Bool(true)),
        ));
    }
    let current = current_effort.filter(|c| options.iter().any(|(o, _)| &o.id == c));
    let defaults: Vec<&String> = options
        .iter()
        .filter(|(_, advertised)| *advertised)
        .map(|(o, _)| &o.id)
        .collect();
    let selected_default = defaults
        .iter()
        .find(|id| Some(**id) == current.as_ref())
        .or(defaults.first())
        .map(|id| (*id).clone());
    let rank = |id: &str| GROK_EFFORT_RANK.iter().position(|r| *r == id);
    if options.iter().all(|(o, _)| rank(&o.id).is_some()) {
        options.sort_by_key(|(o, _)| rank(&o.id));
    }
    let options: Vec<ProviderOptionChoice> = options
        .into_iter()
        .map(|(mut o, _)| {
            if Some(&o.id) == selected_default.as_ref() {
                o.is_default = Some(true);
            }
            o
        })
        .collect();
    (options, current.or(selected_default))
}

/// v1 `buildGrokModelCapabilities` (status.ts:208-228).
pub fn grok_model_capabilities(meta: Option<&Value>) -> ModelCapabilities {
    let (options, current) = grok_reasoning_options(meta);
    if options.is_empty() {
        return empty_capabilities();
    }
    create_model_capabilities(vec![ProviderOptionDescriptor::Select {
        id: "reasoningEffort".into(),
        label: "Reasoning".into(),
        description: None,
        options,
        current_value: current,
        prompt_injected_values: None,
        role: None,
    }])
}

/// v1 `buildGrokModelsFromSessionModelState` (status.ts:230-254).
pub fn grok_models_from_model_state(state: Option<&Value>) -> Vec<ServerProviderModel> {
    let Some(state) = state else {
        return Vec::new();
    };
    let current = state
        .get("currentModelId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for model in state
        .get("availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(model_id) = model.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        let slug = resolve_grok_base_model_id(Some(model_id));
        if !seen.insert(slug.clone()) {
            continue;
        }
        let name = model
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&slug)
            .to_owned();
        let mut entry = built_in_model(slug, name);
        if model_id.trim() == current {
            entry.is_default = Some(true);
        }
        entry.capabilities = Some(grok_model_capabilities(model.get("_meta")));
        out.push(entry);
    }
    out
}

/// v1 `sessionModelStateFromInitialize` (provider-acp runtimeModel.ts:1234-1240), with v1's
/// `isSessionModelState` shape check.
pub fn session_model_state_from_initialize(initialize: &Value) -> Option<&Value> {
    let state = initialize.get("_meta")?.get("modelState")?;
    let valid = state.get("currentModelId").is_some_and(Value::is_string)
        && state
            .get("availableModels")
            .and_then(Value::as_array)
            .is_some_and(|list| {
                list.iter().all(|m| {
                    m.get("modelId").is_some_and(Value::is_string)
                        && m.get("name").is_some_and(Value::is_string)
                })
            });
    valid.then_some(state)
}

/// v1 `GrokModelsCliOutput`.
#[derive(Debug, Clone, PartialEq)]
pub struct GrokModelsCliOutput {
    pub authenticated: Option<bool>,
    pub models: Vec<ServerProviderModel>,
}

/// v1 `parseGrokModelsCliOutput` (status.ts:261-290): the exit status is always 0; only the text
/// tells the login state.
pub fn parse_grok_models_cli_output(output: &str) -> GrokModelsCliOutput {
    let lower = output.to_lowercase();
    let authenticated = if lower.contains("you are logged in") {
        Some(true)
    } else if lower.contains("not authenticated") || lower.contains("not logged in") {
        Some(false)
    } else {
        None
    };
    let bullet = regex::Regex::new(r"^\s*[*-]\s+(\S+)(.*)$").expect("valid pattern");
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(found) = bullet.captures(line) else {
            continue;
        };
        let slug = resolve_grok_base_model_id(found.get(1).map(|m| m.as_str()));
        if !seen.insert(slug.clone()) {
            continue;
        }
        let rest = found.get(2).map(|m| m.as_str()).unwrap_or_default();
        let mut model = built_in_model(slug.clone(), display_name_from_slug(&slug));
        if rest.to_lowercase().contains("(default)") {
            model.is_default = Some(true);
        }
        model.capabilities = Some(empty_capabilities());
        models.push(model);
    }
    GrokModelsCliOutput {
        authenticated,
        models,
    }
}

/// v1 `displayNameFromGrokModelSlug` (status.ts:292-297).
fn display_name_from_slug(slug: &str) -> String {
    slug.split(['-', '_'])
        .map(|part| {
            if part.eq_ignore_ascii_case("grok") {
                "Grok"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// v1 `grokAcpSpawnArgs(undefined)` (acpSupport.ts:133-137): the probe runs no permission mode.
pub const GROK_PROBE_ACP_ARGS: [&str; 2] = ["agent", "stdio"];

/// Send `initialize` to an ACP agent over stdio and return its result, nothing more (v1
/// `discoverGrokMetadataViaAcpInitialize`, status.ts:383-401). The child is killed on return.
/// Lines are read with the driver's bounded frame reader, so a line past 16 Mi characters fails
/// the probe before it is held whole (v1 effect-acp strictParser.ts:18-30; final review 6
/// finding D1).
pub async fn acp_initialize_only(
    program: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: Option<&Path>,
    params: Value,
) -> Result<Value, String> {
    // Resolved against the child's PATH so std keeps posix_spawn (crate::process module docs).
    let resolved =
        crate::process::resolve_program(program, env.get("PATH").map(std::ffi::OsStr::new), cwd)
            .map_err(|e| format!("spawn: {e}"))?;
    let mut command = tokio::process::Command::new(resolved);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| format!("spawn: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let request = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params});
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    stdin.flush().await.map_err(|e| format!("write: {e}"))?;
    let mut reader = tokio::io::BufReader::new(stdout);
    while let Some(line) = crate::engine::read_frame(&mut reader)
        .await
        .map_err(|e| format!("read: {e}"))?
    {
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if message.get("id") != Some(&json!(1)) || message.get("method").is_some() {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("initialize: {error}"));
        }
        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
    }
    Err("the agent closed stdout before answering initialize".into())
}

/// v1 `makeGrokAcpRuntime` initialize request: `clientType: extension` (acpSupport.ts:194).
fn grok_initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
        "clientInfo": {"name": "t3-code-provider-probe", "version": "0.0.0"},
        "_meta": {"clientType": "extension"}
    })
}

/// What v1 `buildServerProvider` (snapshotProbe.ts:316-373) takes besides the probe fields.
struct Snapshot {
    checked_at: String,
    enabled: bool,
    binary_path: Option<String>,
    models: Vec<ServerProviderModel>,
}

impl Snapshot {
    /// v1 `buildServerProvider` with v1's `ProviderProbeResult` fields as arguments.
    #[allow(clippy::too_many_arguments)]
    fn build(
        &self,
        installed: bool,
        cli: Option<ServerProviderCli>,
        version: Option<String>,
        status: ServerProviderState,
        auth: ServerProviderAuth,
        message: Option<String>,
        models: Option<Vec<ServerProviderModel>>,
    ) -> ProviderProbeResult {
        ProviderProbeResult {
            installed,
            version,
            installed_version: None,
            cli,
            binary_path: if installed {
                self.binary_path.clone()
            } else {
                None
            },
            status: if self.enabled {
                status
            } else {
                ServerProviderState::Disabled
            },
            auth,
            models: models.unwrap_or_else(|| self.models.clone()),
            checked_at: self.checked_at.clone(),
            message,
        }
    }
}

/// Run `grok models` once (v1 `probeGrokModels`, status.ts:317-346): only a clean exit is parsed.
async fn probe_grok_models(
    program: &Path,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> GrokModelsCliOutput {
    match spawn_and_collect(program, &["models".to_owned()], env, None, timeout).await {
        Ok(Some(output)) if output.code == 0 => {
            parse_grok_models_cli_output(&format!("{}\n{}", output.stdout, output.stderr))
        }
        _ => GrokModelsCliOutput {
            authenticated: None,
            models: Vec::new(),
        },
    }
}

/// v1 `checkGrokProviderStatus` (status.ts:403-623).
pub async fn check_grok_provider_status(
    factory: &AcpEngineFactory,
    config: &ProbeConfig,
) -> ProviderProbeResult {
    let unknown = || auth_status(ServerProviderAuthStatus::Unknown);
    let fallback = grok_models_from_settings(&config.custom_models, built_in_models());
    let mut snapshot = Snapshot {
        checked_at: checked_at_now(),
        enabled: config.enabled,
        binary_path: None,
        models: fallback.clone(),
    };
    if !config.enabled {
        return snapshot.build(
            false,
            None,
            None,
            ServerProviderState::Warning,
            unknown(),
            Some("Grok is disabled in GOAT settings.".into()),
            None,
        );
    }
    let Some(spawn_cwd) = safe_process_cwd() else {
        return snapshot.build(
            true,
            None,
            None,
            ServerProviderState::Error,
            unknown(),
            Some("The GOAT server process cannot access its working directory.".into()),
            None,
        );
    };
    let command = match effective_command(factory, config, &spawn_cwd) {
        Ok(command) => command,
        Err(error) => {
            return snapshot.build(
                true,
                None,
                None,
                ServerProviderState::Error,
                unknown(),
                Some(format!("Failed to execute Grok CLI health check: {error}")),
                None,
            );
        }
    };
    let environment = instance_environment([command.env.as_slice()]);
    // v1 grokProbeEnvironment: suppress probe-time updater consoles.
    let mut probe_env = child_environment([command.env.as_slice()]);
    probe_env.insert("GROK_DISABLE_AUTOUPDATER".into(), "1".into());
    let api_key = environment
        .get(GROK_API_KEY_ENV)
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .is_some();
    let program: PathBuf = command.program.clone();
    let binary = program.to_string_lossy().into_owned();
    snapshot.binary_path = resolve_executable(&program, Some(&spawn_cwd), &probe_env)
        .map(|p| p.to_string_lossy().into_owned());

    let version_result = spawn_and_collect(
        &program,
        &["--version".to_owned()],
        &probe_env,
        Some(&spawn_cwd),
        resolve_provider_probe_timeout("grok", VERSION_PROBE_TIMEOUT_MS, &environment),
    )
    .await;
    let version_output = match version_result {
        Err(error) => {
            let failure = classify_spawn_failure(&error, Some(&spawn_cwd), &binary, &probe_env);
            let missing = failure == SpawnFailure::Missing;
            return snapshot.build(
                !missing,
                missing.then_some(ServerProviderCli::Missing),
                None,
                ServerProviderState::Error,
                unknown(),
                Some(if missing {
                    with_login_shell_path_note(
                        "Grok CLI (`grok`) is not installed or not on PATH.",
                        &environment,
                    )
                } else {
                    spawn_failure_message_with_homes(
                        failure,
                        Some(&spawn_cwd),
                        &binary,
                        &probe_homes(&environment),
                    )
                    .unwrap_or_else(|| "Failed to execute Grok CLI health check.".into())
                }),
                None,
            );
        }
        Ok(None) => {
            return snapshot.build(
                true,
                None,
                None,
                ServerProviderState::Error,
                unknown(),
                Some("Grok CLI is installed but timed out while running `grok --version`.".into()),
                None,
            );
        }
        Ok(Some(output)) => output,
    };
    let version = parse_cli_version_result(&version_output);
    if version_output.code != 0 {
        return snapshot.build(
            true,
            Some(ServerProviderCli::Present),
            version,
            ServerProviderState::Error,
            unknown(),
            Some("Grok CLI is installed but failed to run.".into()),
            None,
        );
    }

    // `grok models` reports login state and model slugs without starting the agent.
    let models_timeout =
        resolve_provider_probe_timeout("grok", AUTH_PROBE_TIMEOUT_MS, &environment);
    let mut cli_models = probe_grok_models(&program, &probe_env, models_timeout).await;
    // An expired access token prints the logged-out line, then the CLI refreshes it in the same
    // process. Probing again after that process exited tells a refresh from a real logout.
    if cli_models.authenticated == Some(false) && !api_key {
        let recheck = probe_grok_models(&program, &probe_env, models_timeout).await;
        if recheck.authenticated.is_some() {
            cli_models = recheck;
        }
    }
    let auth = if api_key {
        ServerProviderAuth {
            auth_type: Some("api_key".into()),
            label: Some("xAI API key".into()),
            ..auth_status(ServerProviderAuthStatus::Authenticated)
        }
    } else {
        match cli_models.authenticated {
            Some(true) => ServerProviderAuth {
                auth_type: Some("cached_token".into()),
                label: Some("Grok account".into()),
                ..auth_status(ServerProviderAuthStatus::Authenticated)
            },
            Some(false) => auth_status(ServerProviderAuthStatus::Unauthenticated),
            None => unknown(),
        }
    };

    let acp = tokio::time::timeout(
        resolve_provider_probe_timeout("grok", GROK_ACP_INITIALIZE_TIMEOUT_MS, &environment),
        acp_initialize_only(
            &program,
            &GROK_PROBE_ACP_ARGS.map(str::to_owned),
            &probe_env,
            Some(&spawn_cwd),
            grok_initialize_params(),
        ),
    )
    .await;
    let (acp_failed, acp_models) = match acp {
        Ok(Ok(initialized)) => (
            false,
            grok_models_from_model_state(session_model_state_from_initialize(&initialized)),
        ),
        _ => (true, Vec::new()),
    };
    let discovered = if acp_models.is_empty() {
        cli_models.models
    } else {
        acp_models
    };
    let models = if discovered.is_empty() {
        fallback
    } else {
        grok_models_from_settings(&config.custom_models, discovered.clone())
    };
    // The registry replaces cached models on a ready probe, so a fallback-only list must not be ready.
    let incomplete = if acp_failed {
        Some("Grok CLI is installed but ACP initialize failed. Model options may be incomplete.")
    } else if discovered.is_empty() {
        Some("Grok CLI did not list any models. Model options may be incomplete.")
    } else {
        None
    };
    if auth.status == ServerProviderAuthStatus::Unauthenticated {
        return snapshot.build(
            true,
            Some(ServerProviderCli::Present),
            version,
            ServerProviderState::Error,
            auth,
            Some(
                "Grok CLI is installed but not logged in. Add an xAI API key, or run `grok login`."
                    .into(),
            ),
            Some(models),
        );
    }
    snapshot.build(
        true,
        Some(ServerProviderCli::Present),
        version,
        if incomplete.is_some() {
            ServerProviderState::Warning
        } else {
            ServerProviderState::Ready
        },
        auth,
        incomplete.map(str::to_owned),
        Some(models),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_output_reads_login_and_bullets() {
        let parsed = parse_grok_models_cli_output(
            "You are logged in as x\nAvailable models:\n  * grok-build (default)\n  - grok-4_fast\n  * grok-build\n",
        );
        assert_eq!(parsed.authenticated, Some(true));
        assert_eq!(parsed.models.len(), 2);
        assert_eq!(parsed.models[0].is_default, Some(true));
        assert_eq!(parsed.models[1].name, "Grok 4 fast");
        assert_eq!(
            parse_grok_models_cli_output("Error: not logged in").authenticated,
            Some(false)
        );
        assert_eq!(parse_grok_models_cli_output("hello").authenticated, None);
    }

    #[test]
    fn reasoning_options_rank_and_default_like_v1() {
        let meta = json!({"reasoningEfforts": [
            {"value": "high", "label": "High"},
            {"value": "low", "default": true},
            {"id": "medium", "value": "bad token!"},
            {"value": "low"}
        ], "reasoningEffort": "high"});
        let (options, current) = grok_reasoning_options(Some(&meta));
        let ids: Vec<&str> = options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["low", "medium", "high"]);
        assert_eq!(options[0].is_default, Some(true));
        assert_eq!(current.as_deref(), Some("high"));
        assert!(
            grok_reasoning_options(Some(
                &json!({"supportsReasoningEffort": false, "reasoningEfforts": [{"value": "low"}]})
            ))
            .0
            .is_empty()
        );
        let state = json!({"currentModelId": "grok-build", "availableModels": [
            {"modelId": "grok-build", "name": "Grok Build", "_meta": meta},
            {"modelId": " grok-build ", "name": "dup"}
        ]});
        let models = grok_models_from_model_state(Some(&state));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].is_default, Some(true));
        assert!(
            session_model_state_from_initialize(&json!({"_meta": {"modelState": state}})).is_some()
        );
        assert!(
            session_model_state_from_initialize(
                &json!({"_meta": {"modelState": {"currentModelId": 1}}})
            )
            .is_none()
        );
        assert!(is_valid_reasoning_effort_token("x-high.1"));
        assert!(!is_valid_reasoning_effort_token("-x"));
    }

    /// Final review 6 finding D1 (v1 probes Grok through the effect-acp runtime, whose
    /// `makeStrictNdJsonRpcParser` refuses a line past 16 Mi characters, strictParser.ts:18-30): a
    /// newline-free flood during the initialize probe fails at the frame cap, even when a valid
    /// answer follows it.
    #[cfg(unix)]
    #[tokio::test]
    async fn initialize_probe_refuses_a_frame_past_the_cap() {
        let flood = 16 * 1024 * 1024 + 1;
        let script = format!(
            "read request\nhead -c {flood} /dev/zero | tr '\\0' x\nprintf '\\n%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{\"protocolVersion\":1}}}}'"
        );
        let env: BTreeMap<String, String> =
            [("PATH".to_owned(), "/usr/bin:/bin".to_owned())].into();
        let result = acp_initialize_only(
            Path::new("/bin/sh"),
            &["-c".to_owned(), script],
            &env,
            None,
            grok_initialize_params(),
        )
        .await;
        let error = result.expect_err("a frame past the cap fails the probe");
        assert!(error.contains("maximum size"), "{error}");
    }
}

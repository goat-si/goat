//! fx status, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2)
//! `packages/provider-fx/src/server/status.ts` (`checkFxProviderStatus` :160-257, models :45-79,
//! auth :152-158) and `acpSupport.ts:25-57` (default slug, effort descriptor, full-access mode).
//!
//! v1 reads `fx --version`, `fx status --json` (login and default model) and `fx models --json`.
//! None of them opens an ACP session, which fx would save under `~/.fx`.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use goat2_contracts::{
    ProviderOptionChoice, ProviderOptionDescriptor, ProviderProbeResult, ServerProviderAuth,
    ServerProviderAuthStatus, ServerProviderModel, ServerProviderState,
};
use serde_json::Value;

use super::support::{
    AUTH_PROBE_TIMEOUT_MS, SpawnFailure, auth_status, built_in_model, child_environment,
    classify_spawn_failure, create_model_capabilities, instance_environment,
    parse_cli_version_result, provider_models_from_settings, resolve_executable,
    resolve_provider_probe_timeout, safe_process_cwd, spawn_and_collect, spawn_failure_message,
    with_login_shell_path_note,
};
use super::{ProbeConfig, checked_at_now, effective_command};
use crate::engine::AcpEngineFactory;
use crate::registry::settings::CustomModelSetting as CustomModel;

/// v1 acpSupport.ts:27: GOAT's slug for "Default", never an fx model id.
pub const FX_DEFAULT_MODEL_SLUG: &str = "default";
/// v1 acpSupport.ts:57.
pub const FX_FULL_ACCESS_MODE_ID: &str = "full-access";
/// v1 status.ts:150.
const VERSION_PROBE_TIMEOUT_MS: u64 = 10_000;

/// v1 `FX_EFFORT_OPTION_DESCRIPTOR` (acpSupport.ts:30-51).
pub fn fx_effort_option_descriptor() -> ProviderOptionDescriptor {
    let labels = [
        ("auto", "Auto"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Extra High"),
        ("max", "Max"),
    ];
    ProviderOptionDescriptor::Select {
        id: "effort".into(),
        label: "Effort".into(),
        description: None,
        options: labels
            .iter()
            .map(|(id, label)| ProviderOptionChoice {
                id: (*id).into(),
                label: (*label).into(),
                description: None,
                is_default: (*id == "medium").then_some(true),
            })
            .collect(),
        current_value: None,
        prompt_injected_values: None,
        role: None,
    }
}

/// v1 `fxModels` (status.ts:49-79): "Default" keeps the model `fx status` reports as its alias.
pub fn fx_models(
    custom: &[CustomModel],
    default_model: Option<&str>,
    listed: &[String],
) -> Vec<ServerProviderModel> {
    let capabilities = create_model_capabilities(vec![fx_effort_option_descriptor()]);
    let mut default = built_in_model(
        FX_DEFAULT_MODEL_SLUG,
        match default_model {
            None => "Default".to_owned(),
            Some(model) => format!("Default ({model})"),
        },
    );
    default.aliases = default_model.map(|m| vec![m.to_owned()]);
    default.is_default = Some(true);
    default.capabilities = Some(capabilities.clone());
    let mut models = vec![default];
    for (index, id) in listed.iter().enumerate() {
        if id == FX_DEFAULT_MODEL_SLUG || listed.iter().position(|other| other == id) != Some(index)
        {
            continue;
        }
        let mut model = built_in_model(id.clone(), id.clone());
        model.capabilities = Some(capabilities.clone());
        models.push(model);
    }
    provider_models_from_settings(models, custom, Some(capabilities))
}

/// v1 `fxAuth` (status.ts:152-158).
pub fn fx_auth(auth: Option<&str>) -> ServerProviderAuth {
    match auth.map(str::trim).filter(|a| !a.is_empty()) {
        None => auth_status(ServerProviderAuthStatus::Unknown),
        Some("missing") => auth_status(ServerProviderAuthStatus::Unauthenticated),
        Some(method) => ServerProviderAuth {
            label: Some(method.to_owned()),
            ..auth_status(ServerProviderAuthStatus::Authenticated)
        },
    }
}

/// v1 `FxStatus` (status.ts:136-144): `fx status --json` on fx 0.0.13.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FxStatus {
    pub auth: Option<String>,
    pub model: Option<String>,
    pub modes: Option<Vec<String>>,
}

fn optional_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

/// v1 `decodeFxStatus`: the whole object fails when a present field has the wrong type.
pub fn decode_fx_status(stdout: &str) -> Option<FxStatus> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let object = value.as_object()?;
    let modes = match object.get("modes") {
        None => None,
        Some(Value::Array(list)) => Some(
            list.iter()
                .map(|m| m.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    Some(FxStatus {
        auth: optional_string(object, "auth").ok()?,
        model: optional_string(object, "model").ok()?,
        modes,
    })
}

/// v1 `decodeFxModels`: `{ ids?: string[] }`, blank ids dropped.
pub fn decode_fx_models(stdout: &str) -> Option<Vec<String>> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let object = value.as_object()?;
    match object.get("ids") {
        None => Some(Vec::new()),
        Some(Value::Array(ids)) => ids
            .iter()
            .map(|id| id.as_str().map(|s| s.trim().to_owned()))
            .collect::<Option<Vec<_>>>()
            .map(|ids| ids.into_iter().filter(|id| !id.is_empty()).collect()),
        Some(_) => None,
    }
}

async fn read_json(
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    match spawn_and_collect(program, &args, env, None, timeout).await {
        Ok(Some(output)) if output.code == 0 => Some(output.stdout),
        _ => None,
    }
}

/// v1 `checkFxProviderStatus` (status.ts:164-257).
pub async fn check_fx_provider_status(
    factory: &AcpEngineFactory,
    config: &ProbeConfig,
) -> ProviderProbeResult {
    let checked_at = checked_at_now();
    let unknown = || auth_status(ServerProviderAuthStatus::Unknown);
    let snapshot = |installed: bool,
                    binary_path: Option<String>,
                    version: Option<String>,
                    status: ServerProviderState,
                    auth: ServerProviderAuth,
                    message: Option<String>,
                    default_model: Option<&str>,
                    listed: &[String]| ProviderProbeResult {
        installed,
        version,
        installed_version: None,
        cli: None,
        binary_path: if installed { binary_path } else { None },
        status: if config.enabled {
            status
        } else {
            ServerProviderState::Disabled
        },
        auth,
        models: fx_models(&config.custom_models, default_model, listed),
        checked_at: checked_at.clone(),
        message,
    };
    if !config.enabled {
        return snapshot(
            false,
            None,
            None,
            ServerProviderState::Warning,
            unknown(),
            Some("fx is disabled in GOAT settings.".into()),
            None,
            &[],
        );
    }
    let spawn_cwd = safe_process_cwd();
    let cwd_for_command = spawn_cwd.clone().unwrap_or_else(|| ".".into());
    let command = match effective_command(factory, config, &cwd_for_command) {
        Ok(command) => command,
        Err(error) => {
            return snapshot(
                true,
                None,
                None,
                ServerProviderState::Error,
                unknown(),
                Some(format!("Failed to run `fx --version`: {error}")),
                None,
                &[],
            );
        }
    };
    let environment = instance_environment([command.env.as_slice()]);
    let probe_env = child_environment([command.env.as_slice()]);
    let program = command.program.clone();
    let binary = program.to_string_lossy().into_owned();
    let binary_path = resolve_executable(&program, spawn_cwd.as_deref(), &probe_env)
        .map(|p| p.to_string_lossy().into_owned());
    let version_result = spawn_and_collect(
        &program,
        &["--version".to_owned()],
        &probe_env,
        spawn_cwd.as_deref(),
        resolve_provider_probe_timeout("fx", VERSION_PROBE_TIMEOUT_MS, &environment),
    )
    .await;
    let version_output = match version_result {
        Ok(Some(output)) => output,
        failed => {
            let failure = match &failed {
                Err(error) => {
                    classify_spawn_failure(error, spawn_cwd.as_deref(), &binary, &environment)
                }
                _ => SpawnFailure::Unknown,
            };
            let missing = failure == SpawnFailure::Missing;
            return snapshot(
                !missing,
                binary_path,
                None,
                ServerProviderState::Error,
                unknown(),
                Some(if missing {
                    with_login_shell_path_note("fx is not installed or not on PATH.", &environment)
                } else {
                    spawn_failure_message(failure, spawn_cwd.as_deref(), &binary)
                        .unwrap_or_else(|| "Failed to run `fx --version`.".into())
                }),
                None,
                &[],
            );
        }
    };
    let version = parse_cli_version_result(&version_output);
    if version_output.code != 0 {
        return snapshot(
            true,
            binary_path,
            version,
            ServerProviderState::Error,
            unknown(),
            Some("fx is installed but failed to run.".into()),
            None,
            &[],
        );
    }
    let timeout = resolve_provider_probe_timeout("fx", AUTH_PROBE_TIMEOUT_MS, &environment);
    let status = read_json(&program, &["status", "--json"], &probe_env, timeout)
        .await
        .and_then(|out| decode_fx_status(&out));
    let listed = read_json(&program, &["models", "--json"], &probe_env, timeout)
        .await
        .and_then(|out| decode_fx_models(&out));
    let auth = fx_auth(status.as_ref().and_then(|s| s.auth.as_deref()));
    let default_model = status
        .as_ref()
        .and_then(|s| s.model.as_deref())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let (state, message) = match auth.status {
        ServerProviderAuthStatus::Unauthenticated => (
            ServerProviderState::Error,
            Some("Run `fx login` to sign in.".to_owned()),
        ),
        ServerProviderAuthStatus::Unknown => (
            ServerProviderState::Warning,
            Some("fx is installed but login state could not be determined.".to_owned()),
        ),
        ServerProviderAuthStatus::Authenticated if listed.is_none() => (
            ServerProviderState::Warning,
            Some(
                "fx is installed but model listing failed. Model options may be incomplete."
                    .to_owned(),
            ),
        ),
        ServerProviderAuthStatus::Authenticated => (ServerProviderState::Ready, None),
    };
    snapshot(
        true,
        binary_path,
        version,
        state,
        auth,
        message,
        default_model.as_deref(),
        listed.as_deref().unwrap_or_default(),
    )
}

/// v1 `fxDefaultModelId` (status.ts:259-261).
pub fn fx_default_model_id(models: &[ServerProviderModel]) -> Option<&str> {
    models
        .iter()
        .find(|m| m.slug == FX_DEFAULT_MODEL_SLUG)
        .and_then(|m| m.aliases.as_ref())
        .and_then(|a| a.first())
        .map(String::as_str)
}

/// Whether `fx status` advertised the full-access mode (v1 status.ts:254-255 presentation).
pub fn fx_offers_full_access(status: &FxStatus) -> bool {
    status
        .modes
        .as_ref()
        .is_some_and(|modes| modes.iter().any(|m| m == FX_FULL_ACCESS_MODE_ID))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_models_decode_like_v1() {
        let status =
            decode_fx_status(r#"{"auth":"oauth","model":"fx-1","modes":[{"id":"full-access"}]}"#)
                .unwrap();
        assert_eq!(status.auth.as_deref(), Some("oauth"));
        assert!(fx_offers_full_access(&status));
        assert_eq!(decode_fx_status(r#"{"auth":1}"#), None);
        assert_eq!(decode_fx_status("not json"), None);
        assert_eq!(
            decode_fx_models(r#"{"ids":[" a ","","b"]}"#),
            Some(vec!["a".into(), "b".into()])
        );
        assert_eq!(decode_fx_models(r#"{}"#), Some(vec![]));
        assert_eq!(
            fx_auth(Some("missing")).status,
            ServerProviderAuthStatus::Unauthenticated
        );
        assert_eq!(fx_auth(Some(" ")).status, ServerProviderAuthStatus::Unknown);
        assert_eq!(fx_auth(Some("oauth")).label.as_deref(), Some("oauth"));
    }

    #[test]
    fn default_model_carries_the_status_alias() {
        let models = fx_models(
            &[],
            Some("fx-1"),
            &["default".into(), "fx-2".into(), "fx-2".into()],
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "Default (fx-1)");
        assert_eq!(fx_default_model_id(&models), Some("fx-1"));
        assert_eq!(models[1].slug, "fx-2");
    }
}

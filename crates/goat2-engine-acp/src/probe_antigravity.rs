//! Antigravity status, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2):
//! - `apps/server/src/provider/AntigravityProvider.ts:49-58,182-196,234-271,388-475`
//!   (`checkAntigravityProvider`, messages, `isMissingInstallation`)
//! - `apps/server/src/provider/Drivers/AntigravityDriver.ts:661-726` (the probe resolves the runtime
//!   without spawning it: the agent is a one-file bundle that unpacks about 1 GB per launch)
//! - `apps/server/src/provider/antigravityAuthSupport.ts:112-144` (labels and settings issues)
//! - `apps/server/src/provider/AntigravityInstallation.ts:272-308` (resolution order and messages)

use std::path::{Path, PathBuf};

use goat2_contracts::{
    ProviderProbeResult, ServerProviderAuth, ServerProviderAuthStatus, ServerProviderState,
};

use super::support::{auth_status, child_environment, resolve_executable, safe_process_cwd};
use super::{ProbeConfig, checked_at_now, effective_command};
use crate::engine::AcpEngineFactory;
use crate::flavor::AuthPolicy;

/// v1 AntigravityProvider.ts:52-54.
pub const SIGN_IN_MESSAGE: &str = "Sign in with Google to use Antigravity.";
pub const AUTH_UNCHECKED_MESSAGE: &str =
    "Antigravity is installed. Google account access is not checked yet.";
/// v1 AntigravityProvider.ts:51.
pub const HEALTH_CHECK_TIMEOUT_MS: u64 = 90_000;

/// The Antigravity credential settings a probe checks (v1 `AntigravityAuthConfig`); the key itself
/// stays with the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AntigravityProbeSettings {
    pub api_key_set: bool,
    pub gcp_project: String,
    pub gcp_location: String,
}

/// v1 `antigravityAuthLabel` (antigravityAuthSupport.ts:116-127).
pub fn antigravity_auth_label(method: &str) -> &'static str {
    match method {
        "oauth-business" => "Gemini Enterprise",
        "gemini-api-key" => "Gemini API key",
        "agent-platform" => "Agent Platform",
        _ => "Google account",
    }
}

/// v1 `antigravityAuthConfigIssue` (antigravityAuthSupport.ts:129-144).
pub fn antigravity_auth_config_issue(
    method: &str,
    settings: &AntigravityProbeSettings,
) -> Option<&'static str> {
    let gcp = !settings.gcp_project.is_empty() && !settings.gcp_location.is_empty();
    match method {
        "oauth-business" if !gcp => Some(
            "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.",
        ),
        "gemini-api-key" if !settings.api_key_set => {
            Some("Enter a Gemini API key in the Antigravity provider settings.")
        }
        "agent-platform" if !settings.api_key_set && !gcp => Some(
            "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.",
        ),
        _ => None,
    }
}

/// v1 AntigravityInstallation.ts:282-307 (resolve without a managed release).
const CUSTOM_MISSING: &str = "The custom Antigravity executable is missing or not executable, or it needs a localharness_external sibling. The agy CLI does not.";
const NOT_INSTALLED: &str = "Antigravity ACP runtime is not installed. Install it in this environment's provider settings or set a custom ACP executable path. The Antigravity app, IDE, and CLI are separate installations.";

/// Find the runtime the way v1's `AntigravityInstallation.resolve` does without a managed release:
/// the custom executable, else the runtime and then `agy` on PATH. Err: v1's resolve detail.
pub fn resolve_antigravity_executable(
    custom: Option<&Path>,
    default_program: &Path,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<PathBuf, &'static str> {
    if let Some(custom) = custom.filter(|c| !c.as_os_str().is_empty()) {
        return resolve_executable(custom, env).ok_or(CUSTOM_MISSING);
    }
    [default_program, Path::new("agy")]
        .into_iter()
        .find_map(|candidate| resolve_executable(candidate, env))
        .ok_or(NOT_INSTALLED)
}

/// v1 `checkAntigravityProvider` (AntigravityProvider.ts:388-475) for a probe with no session
/// history: auth is `unknown` until a session confirms the account.
pub fn check_antigravity_provider(
    factory: &AcpEngineFactory,
    config: &ProbeConfig,
) -> ProviderProbeResult {
    let method = match factory.flavor().auth_policy() {
        AuthPolicy::Eager { method_id } => method_id,
        AuthPolicy::OnRequired { method_id } => {
            method_id.unwrap_or_else(|| "oauth-personal".into())
        }
    };
    let label = antigravity_auth_label(&method);
    let uses_credentials = matches!(method.as_str(), "gemini-api-key" | "agent-platform");
    let auth = ServerProviderAuth {
        auth_type: Some(method.clone()),
        ..auth_status(ServerProviderAuthStatus::Unknown)
    };
    let result = |installed: bool,
                  binary_path: Option<String>,
                  status: ServerProviderState,
                  message: String| ProviderProbeResult {
        installed,
        version: None,
        installed_version: None,
        cli: None,
        binary_path,
        status: if config.enabled {
            status
        } else {
            ServerProviderState::Disabled
        },
        auth: auth.clone(),
        models: Vec::new(),
        checked_at: checked_at_now(),
        message: Some(message),
    };
    if !config.enabled {
        return result(
            false,
            None,
            ServerProviderState::Warning,
            "Antigravity is disabled in GOAT settings.".into(),
        );
    }
    if let Some(issue) = antigravity_auth_config_issue(&method, &config.antigravity) {
        // v1: a ProviderSetupError with operation "configure" is not a missing installation.
        return result(true, None, ServerProviderState::Error, issue.into());
    }
    let cwd = config
        .cwd
        .clone()
        .or_else(safe_process_cwd)
        .unwrap_or_else(|| PathBuf::from("."));
    let command = match effective_command(factory, config, &cwd) {
        Ok(command) => command,
        Err(error) => {
            return result(
                true,
                None,
                ServerProviderState::Error,
                format!("Antigravity could not complete its local health check. {error}"),
            );
        }
    };
    let env = child_environment([command.env.as_slice()]);
    let custom = config.launch.as_ref().and_then(|l| l.binary.as_deref());
    let flavor_program = factory
        .flavor()
        .launch(&super::probe_spec(&cwd, None))
        .map(|c| c.program)
        .unwrap_or_else(|_| command.program.clone());
    match resolve_antigravity_executable(custom, &flavor_program, &env) {
        // v1 isMissingInstallation: a resolve detail matching /not installed|missing/.
        Err(detail) => result(false, None, ServerProviderState::Error, detail.into()),
        Ok(path) => result(
            true,
            Some(path.to_string_lossy().into_owned()),
            ServerProviderState::Warning,
            if uses_credentials {
                format!("Antigravity is installed. Connect with {label} to load models.")
            } else {
                AUTH_UNCHECKED_MESSAGE.into()
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_settings_issues_match_v1() {
        assert_eq!(antigravity_auth_label("oauth-personal"), "Google account");
        assert_eq!(antigravity_auth_label("gemini-api-key"), "Gemini API key");
        let none = AntigravityProbeSettings::default();
        assert_eq!(antigravity_auth_config_issue("oauth-personal", &none), None);
        assert_eq!(
            antigravity_auth_config_issue("gemini-api-key", &none),
            Some("Enter a Gemini API key in the Antigravity provider settings.")
        );
        let gcp = AntigravityProbeSettings {
            api_key_set: false,
            gcp_project: "p".into(),
            gcp_location: "l".into(),
        };
        assert_eq!(antigravity_auth_config_issue("agent-platform", &gcp), None);
        assert!(antigravity_auth_config_issue("oauth-business", &none).is_some());
    }

    #[test]
    fn resolution_prefers_custom_then_runtime_then_agy() {
        let dir = tempfile::tempdir().unwrap();
        let env = std::collections::BTreeMap::from([(
            "PATH".to_owned(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        assert_eq!(
            resolve_antigravity_executable(None, Path::new("agy_acp_server"), &env),
            Err(NOT_INSTALLED)
        );
        std::fs::write(dir.path().join("agy"), b"").unwrap();
        assert_eq!(
            resolve_antigravity_executable(None, Path::new("agy_acp_server"), &env),
            Ok(dir.path().join("agy"))
        );
        assert_eq!(
            resolve_antigravity_executable(Some(Path::new("/goat2-no/agy")), Path::new("agy_acp_server"), &env),
            Err(CUSTOM_MISSING)
        );
    }
}

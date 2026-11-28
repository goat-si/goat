//! Provider probe without a session: is `claude` installed, which version, signed in, which
//! models.
//!
//! v1 probes by opening an SDK query (`provider/ClaudeProvider.ts`); GOAT 2 asks the CLI directly:
//! `claude --version` and `claude auth status` (JSON). Messages follow v1
//! (`ClaudeProvider.ts:861-885`). Models are v1's bundled manifest entry for `claudeAgent`
//! (`apps/server/src/provider/model-manifest.json`, copied verbatim into
//! `data/model-manifest.claudeAgent.json`), filtered by each model's `claudeCode.minVersion`.

use std::process::Stdio;
use std::time::Duration;

use goat2_contracts::{
    ModelCapabilities, ProviderProbeResult, ServerProviderAuth, ServerProviderAuthStatus,
    ServerProviderCli, ServerProviderModel, ServerProviderState,
};
use serde_json::Value;
use tokio::process::Command;

use crate::launch::LaunchOptions;
use crate::util;

pub(crate) const MANIFEST: &str = include_str!("../data/model-manifest.claudeAgent.json");
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

async fn run(options: &LaunchOptions, args: &[&str]) -> Result<(bool, String), String> {
    let mut command = Command::new(&options.binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_AGENT_SDK_VERSION",
    ] {
        command.env_remove(name);
    }
    for (key, value) in &options.env {
        command.env(key, value);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("{} {} timed out", options.binary.display(), args.join(" ")))?
        .map_err(|error| error.to_string())?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

/// `2.1.332 (Claude Code)` -> `2.1.332`.
fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| word.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_owned)
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// Models for this CLI version from the bundled manifest.
pub fn manifest_models(version: Option<&str>) -> Vec<ServerProviderModel> {
    let manifest: Value = serde_json::from_str(MANIFEST).unwrap_or(Value::Null);
    let default = manifest
        .pointer("/defaults/chat")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let installed = version.map(version_parts);
    let Some(models) = manifest.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter(|model| {
            let min = model
                .pointer("/adapter/claudeCode/minVersion")
                .and_then(Value::as_str);
            match (min, &installed) {
                (Some(min), Some(installed)) => version_parts(min) <= *installed,
                _ => true,
            }
        })
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?.to_string();
            let capabilities = model
                .get("profile")
                .and_then(Value::as_str)
                .and_then(|profile| manifest.pointer(&format!("/profiles/{profile}/capabilities")))
                .and_then(|value| serde_json::from_value::<ModelCapabilities>(value.clone()).ok());
            Some(ServerProviderModel {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&slug)
                    .to_string(),
                short_name: None,
                sub_provider: None,
                aliases: model
                    .get("aliases")
                    .and_then(|a| serde_json::from_value::<Vec<String>>(a.clone()).ok()),
                badge: None,
                is_custom: false,
                is_default: (slug == default).then_some(true),
                is_legacy: (model.get("status").and_then(Value::as_str) == Some("legacy"))
                    .then_some(true),
                supports_text_generation: None,
                capabilities,
                slug,
            })
        })
        .collect()
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

/// Parse `claude auth status` JSON.
pub fn parse_auth_status(text: &str) -> ServerProviderAuth {
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
        return auth(ServerProviderAuthStatus::Unknown);
    };
    let status = match value.get("loggedIn").and_then(Value::as_bool) {
        Some(true) => ServerProviderAuthStatus::Authenticated,
        Some(false) => ServerProviderAuthStatus::Unauthenticated,
        None => ServerProviderAuthStatus::Unknown,
    };
    let mut result = auth(status);
    result.auth_type = value
        .get("authMethod")
        .and_then(Value::as_str)
        .filter(|method| *method != "none")
        .map(str::to_owned);
    result.email = value
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned);
    result.label = value
        .get("subscriptionType")
        .or_else(|| value.get("orgName"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    result
}

/// Probe the CLI.
pub async fn probe(options: &LaunchOptions) -> ProviderProbeResult {
    let checked_at = util::now_rfc3339();
    let version = match run(options, &["--version"]).await {
        Ok((true, stdout)) => parse_version(&stdout),
        _ => {
            return ProviderProbeResult {
                installed: false,
                version: None,
                installed_version: None,
                cli: Some(ServerProviderCli::Missing),
                binary_path: Some(options.binary.display().to_string()),
                status: ServerProviderState::Error,
                auth: auth(ServerProviderAuthStatus::Unknown),
                models: Vec::new(),
                checked_at,
                message: Some(format!(
                    "Claude Code CLI was not found at {}. Install it or set the binary path.",
                    options.binary.display()
                )),
            };
        }
    };
    let auth = match run(options, &["auth", "status"]).await {
        Ok((_, stdout)) => parse_auth_status(&stdout),
        Err(_) => auth(ServerProviderAuthStatus::Unknown),
    };
    let (status, message) = match auth.status {
        ServerProviderAuthStatus::Authenticated => (ServerProviderState::Ready, None),
        ServerProviderAuthStatus::Unauthenticated => (
            ServerProviderState::Error,
            Some(
                "Claude Code is not authenticated. Run `claude auth login` and try again."
                    .to_string(),
            ),
        ),
        ServerProviderAuthStatus::Unknown => (
            ServerProviderState::Warning,
            Some("Could not verify Claude authentication status.".to_string()),
        ),
    };
    ProviderProbeResult {
        installed: true,
        models: manifest_models(version.as_deref()),
        version,
        installed_version: None,
        cli: Some(ServerProviderCli::Present),
        binary_path: Some(options.binary.display().to_string()),
        status,
        auth,
        checked_at,
        message,
    }
}

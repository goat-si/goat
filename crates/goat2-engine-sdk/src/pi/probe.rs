//! v1 provider-pi/src/server/status.ts:118-158,193-215,295-315,472-510.
use super::session::{PiProfile, base_launch, spawn};
use goat2_contracts::{
    ProviderProbeResult, ServerProviderAuth, ServerProviderAuthStatus, ServerProviderCli,
    ServerProviderModel, ServerProviderState,
};
use goat2_engine_api::EngineError;
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

pub(super) async fn probe(
    binary: &Path,
    profile: PiProfile,
) -> Result<ProviderProbeResult, EngineError> {
    let checked_at = super::events::now();
    let mut command = tokio::process::Command::new(binary);
    command.arg("--version").kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("GOAT_")
            || key_text.starts_with("T3CODE_")
            || key_text.starts_with("CODEX_")
        {
            command.env_remove(key);
        }
    }
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| EngineError::Transport("Pi version probe timed out".into()))?;
    let auth_unknown = || ServerProviderAuth {
        status: ServerProviderAuthStatus::Unknown,
        auth_type: None,
        label: None,
        email: None,
        can_logout: None,
        subscription_sharing: None,
        profile_id: None,
        workspace_id: None,
        endpoint: None,
    };
    let output = match output {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProviderProbeResult {
                installed: false,
                version: None,
                installed_version: None,
                cli: Some(ServerProviderCli::Missing),
                binary_path: Some(binary.display().to_string()),
                status: ServerProviderState::Error,
                auth: auth_unknown(),
                models: vec![],
                checked_at,
                message: Some(format!("{} executable not found", profile.binary())),
            });
        }
        Err(e) => return Err(EngineError::Unavailable(e.to_string())),
    };
    if !output.status.success() {
        return Err(EngineError::Unavailable(format!(
            "{} version command failed ({})",
            profile.binary(),
            output.status
        )));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let mut launch = base_launch(binary.to_path_buf(), profile);
    launch.args.extend([
        "--mode".into(),
        "rpc".into(),
        "--no-session".into(),
        "--offline".into(),
    ]);
    let (mut child, client, _inbound) = spawn(&launch)?;
    let inventory = async {
        client.call(json!({"type":"get_state"})).await?;
        client.call(json!({"type":"get_available_models"})).await
    }
    .await;
    child.shutdown().await;
    let inventory = inventory.map_err(|e| EngineError::Transport(e.to_string()))?;
    let models = inventory
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| EngineError::Transport("invalid Pi model inventory".into()))?;
    let mut seen = HashSet::new();
    let mut parsed = Vec::new();
    for model in models {
        let provider = model
            .get("provider")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| EngineError::Transport("invalid Pi model provider".into()))?;
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| EngineError::Transport("invalid Pi model id".into()))?;
        let slug = format!("{provider}/{id}");
        if seen.insert(slug.clone()) {
            parsed.push(ServerProviderModel {
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&slug)
                    .into(),
                slug,
                short_name: None,
                sub_provider: Some(provider.into()),
                aliases: None,
                badge: None,
                is_custom: false,
                is_default: None,
                is_legacy: None,
                supports_text_generation: None,
                capabilities: None,
            });
        }
    }
    let authenticated = !parsed.is_empty();
    let mut auth = auth_unknown();
    auth.status = if authenticated {
        ServerProviderAuthStatus::Authenticated
    } else {
        ServerProviderAuthStatus::Unauthenticated
    };
    Ok(ProviderProbeResult {
        installed: true,
        version: Some(version),
        installed_version: None,
        cli: Some(ServerProviderCli::Present),
        binary_path: Some(binary.display().to_string()),
        status: if authenticated {
            ServerProviderState::Ready
        } else {
            ServerProviderState::Warning
        },
        auth,
        models: parsed,
        checked_at,
        message: None,
    })
}

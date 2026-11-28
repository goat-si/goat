//! Provider probes: install, version, sign-in state and models for one ACP provider instance,
//! without starting a thread. v1 (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-acp-registry/src/server/probe.ts` (probe session: no sign-in, advertised
//!   models and commands, `session/delete` when advertised) and `probeFingerprint.ts`
//! - `packages/provider-acp-registry/src/server/driverSnapshots.ts` / `snapshotReadiness.ts`
//!   (registry agents, [registry])
//! - `packages/provider-grok/src/server/status.ts` ([grok]), `packages/provider-fx/src/server/status.ts`
//!   ([fx]), `apps/server/src/provider/AntigravityProvider.ts` ([antigravity])
//!
//! [crate::engine::AcpEngineFactory]'s `EngineFactory::probe` dispatches on the flavor's driver
//! kind, as v1 runs one status check per driver.

use std::collections::BTreeMap;
use std::path::PathBuf;

use goat2_contracts::ProviderProbeResult;
use goat2_engine_api::LaunchSpec;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::registry::settings::{CustomModelSetting as CustomModel, RegistrySettings};

#[path = "probe_antigravity.rs"]
pub mod antigravity;
#[path = "probe_fx.rs"]
pub mod fx;
#[path = "probe_grok.rs"]
pub mod grok;
#[path = "probe_minimax.rs"]
pub mod minimax;
#[path = "probe_models.rs"]
pub mod models;
#[path = "probe_registry.rs"]
pub mod registry;
#[path = "probe_support.rs"]
pub mod support;

/// Hash the environment and spawn descriptor for a probe cache key.
///
/// Adapted from v1 `packages/provider-acp-registry/src/server/probeFingerprint.ts:9-20`:
/// sort the environment by name, encode it with the spawn descriptor, then SHA-256.
/// The fingerprint must be treated as sensitive: it depends on environment values.
pub fn probe_fingerprint(environment: &BTreeMap<String, String>, spawn: &Value) -> String {
    #[derive(Serialize)]
    struct Input<'a> {
        environment: Vec<(&'a String, &'a String)>,
        spawn: &'a Value,
    }
    let bytes = serde_json::to_vec(&Input {
        environment: environment.iter().collect(),
        spawn,
    })
    .expect("strings and JSON values are serializable");
    format!("{:x}", Sha256::digest(bytes))
}

/// v1 probe.ts:72-77.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
pub const COMMAND_ADVERTISEMENT_GRACE: std::time::Duration = std::time::Duration::from_millis(500);
pub const MODEL_ADVERTISEMENT_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
pub const PROBE_SESSION_DELETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// What a probe knows about the provider instance beyond its flavor: v1's per-driver settings
/// (`GrokSettings`, `FxSettings`, `AntigravitySettings`, `AcpRegistrySettings`) and the instance
/// environment. The host sets it with [crate::engine::AcpEngineFactory::with_probe_config].
#[derive(Debug, Clone)]
pub struct ProbeConfig {
    /// v1 settings `enabled`: a disabled instance reports `disabled` without running anything.
    pub enabled: bool,
    /// Where probe commands and sessions run (v1 `host.paths.cwd` for registry agents,
    /// `safeProcessCwd()` for CLI checks). None: the host process's working directory.
    pub cwd: Option<PathBuf>,
    /// The instance's executable, arguments and environment (v1 `binaryPath`, `commandArgs` and
    /// the instance environment), applied over the flavor's command as `SessionSpec.launch` is.
    pub launch: Option<LaunchSpec>,
    /// v1 `customModels`.
    pub custom_models: Vec<CustomModel>,
    /// v1 `AcpRegistrySettings` for registry and local ACP agents (source, `authMethodId`,
    /// `commandPath`). None: a registry agent with default settings.
    pub registry: Option<RegistrySettings>,
    /// The version the registry index lists for the agent (v1 `inspection.version`).
    pub registry_version: Option<String>,
    /// Models whose options the probe reads by selecting each one in its session (v1
    /// `AcpRegistryModelDiscovery.onProbed` answer), in priority order.
    pub discover_models: Vec<String>,
    /// Antigravity credential settings (v1 `AntigravityAuthConfig`, without the key itself).
    pub antigravity: antigravity::AntigravityProbeSettings,
}

impl Default for ProbeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cwd: None,
            launch: None,
            custom_models: Vec::new(),
            registry: None,
            registry_version: None,
            discover_models: Vec::new(),
            antigravity: antigravity::AntigravityProbeSettings::default(),
        }
    }
}

/// A probe that could not open a session.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpProbeFailure {
    pub message: String,
    /// The agent answered session setup with "authentication required".
    pub auth_required: bool,
    /// What `initialize` advertised, for the sign-in actions (v1 normalizeAcpRegistryAuthMethods).
    pub auth_methods: Vec<crate::wire::AuthMethodInfo>,
    /// A sign-in URL the agent printed or sent before failing.
    pub auth_url: Option<String>,
    /// The session did not open within the probe deadline (v1 probe.ts:559-570).
    pub timed_out: bool,
    /// The raw `initialize` result when the agent got that far (env-var and terminal sign-in
    /// details that [crate::wire::AuthMethodInfo] does not keep).
    pub initialize_raw: Option<Value>,
}

/// An open probe session; [AcpProbeSession::close] deletes it when the agent supports that.
pub struct AcpProbeSession {
    pub session: crate::engine::AcpSession,
    pub events: tokio::sync::mpsc::UnboundedReceiver<goat2_engine_api::EngineEvent>,
}

impl AcpProbeSession {
    /// v1 probe.ts:493-498: delete the probe's session (agents that persist sessions would keep one
    /// per probe), then stop the agent.
    pub async fn close(self) {
        use goat2_engine_api::EngineSession;
        let _ = self
            .session
            .delete_session(PROBE_SESSION_DELETE_TIMEOUT)
            .await;
        self.session.shutdown().await;
    }
}

/// v1 probe.ts:566: the timeout message.
pub fn probe_timeout_message(timeout: std::time::Duration) -> String {
    format!(
        "The ACP agent did not create a test session within {} seconds. Agent startup may be slow; this check retries on the next provider refresh.",
        timeout.as_secs_f64()
    )
}

impl crate::engine::AcpEngineFactory {
    /// Open a session the way v1's provider probe does (probe.ts:410-546): never sign in, wait for
    /// the advertised models and commands, and fail within [PROBE_TIMEOUT]. Use a factory built with
    /// [crate::engine::AcpEngineFactory::for_probe].
    pub async fn open_probe(
        &self,
        spec: goat2_engine_api::SessionSpec,
    ) -> Result<AcpProbeSession, AcpProbeFailure> {
        self.open_probe_within(spec, PROBE_TIMEOUT).await
    }

    /// [Self::open_probe] with v1's `resolveProviderProbeTimeoutMs` deadline. The session start
    /// and the advertisement waits share it (v1 probe.ts:535-569 runs both under one
    /// `timeoutOrElse`; final review finding 20).
    pub async fn open_probe_within(
        &self,
        spec: goat2_engine_api::SessionSpec,
        timeout: std::time::Duration,
    ) -> Result<AcpProbeSession, AcpProbeFailure> {
        let deadline = tokio::time::Instant::now() + timeout;
        let timed_out = || AcpProbeFailure {
            message: probe_timeout_message(timeout),
            auth_required: false,
            auth_methods: Vec::new(),
            auth_url: None,
            timed_out: true,
            initialize_raw: None,
        };
        let started = match tokio::time::timeout_at(deadline, self.start_inner(spec)).await {
            Err(_) => return Err(timed_out()),
            Ok(Ok(started)) => started,
            Ok(Err(failure)) => {
                let mut auth_url = None;
                if let Some(mut events) = failure.events {
                    while let Ok(event) = events.try_recv() {
                        if let goat2_engine_api::EngineEvent::AuthRequired {
                            url: Some(url), ..
                        } = event
                        {
                            auth_url = Some(url);
                        }
                    }
                }
                let message = failure.error.to_string();
                return Err(AcpProbeFailure {
                    auth_required: message.contains(crate::engine::AUTH_REQUIRED_PREFIX),
                    message,
                    initialize_raw: failure.init.as_ref().map(|i| i.raw.clone()),
                    auth_methods: failure.init.map(|i| i.auth_methods).unwrap_or_default(),
                    auth_url,
                    timed_out: false,
                });
            }
        };
        let probe = AcpProbeSession {
            session: started.session,
            events: started.events,
        };
        let advertised = tokio::time::timeout_at(
            deadline,
            probe
                .session
                .wait_for_advertisements(MODEL_ADVERTISEMENT_GRACE, COMMAND_ADVERTISEMENT_GRACE),
        )
        .await;
        if advertised.is_err() {
            // v1's scope finalizer deletes the probe session and stops the agent (probe.ts:521-525).
            probe.close().await;
            return Err(timed_out());
        }
        Ok(probe)
    }

    /// The instance settings [crate::engine::AcpEngineFactory]'s `EngineFactory::probe` reads.
    pub fn with_probe_config(mut self, config: ProbeConfig) -> Self {
        self.probe_config = std::sync::Arc::new(config);
        self
    }

    pub fn probe_config(&self) -> &ProbeConfig {
        &self.probe_config
    }
}

/// `EngineFactory::probe` for ACP flavors: one v1 status check per driver kind.
pub async fn probe_provider(factory: &crate::engine::AcpEngineFactory) -> ProviderProbeResult {
    let config = factory.probe_config().clone();
    match factory.flavor().driver() {
        "grok" => grok::check_grok_provider_status(factory, &config).await,
        "fx" => fx::check_fx_provider_status(factory, &config).await,
        "antigravity" => antigravity::check_antigravity_provider(factory, &config),
        _ => {
            registry::check_registry_provider_status(factory, &config, None)
                .await
                .provider
        }
    }
}

/// RFC 3339 UTC with milliseconds (v1 `DateTime.formatIso`).
pub(crate) fn checked_at_now() -> String {
    crate::items::rfc3339_ms(crate::items::now_ms())
}

/// A `SessionSpec` for probe work: no GOAT MCP server, the default model, the instance launch.
pub(crate) fn probe_spec(
    cwd: &std::path::Path,
    launch: Option<LaunchSpec>,
) -> goat2_engine_api::SessionSpec {
    use goat2_contracts::{EngineConfig, ModelSelection, ProviderInstanceId, RuntimeMode};
    goat2_engine_api::SessionSpec {
        thread_id: "provider-probe".into(),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("probe"),
            model_selection: ModelSelection {
                instance_id: ProviderInstanceId::new("probe"),
                model: "default".into(),
                options: None,
            },
            runtime_mode: RuntimeMode::ApprovalRequired,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: goat2_engine_api::McpEndpoint {
            url: String::new(),
            bearer_token: String::new(),
        },
        host_generation: 0,
        process_generation: 0,
        instructions: None,
        launch,
    }
}

/// The flavor's command with the instance launch applied, as the driver's `launch_for` does.
pub(crate) fn effective_command(
    factory: &crate::engine::AcpEngineFactory,
    config: &ProbeConfig,
    cwd: &std::path::Path,
) -> Result<crate::flavor::LaunchCommand, goat2_engine_api::EngineError> {
    let mut command = factory.flavor().launch(&probe_spec(cwd, None))?;
    if let Some(over) = &config.launch {
        if let Some(binary) = &over.binary {
            command.program = binary.clone();
        }
        if !over.args.is_empty() {
            command.args = over.args.clone();
        }
        for (name, value) in &over.env {
            command.env.retain(|(n, _)| n != name);
            command.env.push((name.clone(), value.clone()));
        }
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprint_tracks_environment_and_spawn_without_returning_them() {
        let mut env = BTreeMap::from([("PATH".into(), "/fake/bin".into())]);
        let spawn = json!({"command":"fake", "args":["acp"]});
        let first = probe_fingerprint(&env, &spawn);
        assert_eq!(first.len(), 64);
        assert_eq!(first, probe_fingerprint(&env, &spawn));
        env.insert("PATH".into(), "/other/bin".into());
        assert_ne!(first, probe_fingerprint(&env, &spawn));
        env.insert("PATH".into(), "/fake/bin".into());
        assert_ne!(first, probe_fingerprint(&env, &json!({"command":"other"})));
    }

    #[test]
    fn timeout_message_matches_v1() {
        assert_eq!(
            probe_timeout_message(PROBE_TIMEOUT),
            "The ACP agent did not create a test session within 60 seconds. Agent startup may be slow; this check retries on the next provider refresh."
        );
        assert!(
            probe_timeout_message(std::time::Duration::from_millis(90_500))
                .contains("90.5 seconds")
        );
    }
}

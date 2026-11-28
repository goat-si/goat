//! `EngineFactory::probe` against the fake agent: v1's status rules per driver kind.
//! v1 (goat-si/goat 916b5ccc1b2): packages/provider-acp-registry/src/server/{probe.ts,
//! driverSnapshots.ts, snapshotReadiness.ts, deepSeekProbeHistory.ts, modelDiscovery.ts},
//! packages/provider-grok/src/server/status.ts, packages/provider-fx/src/server/status.ts,
//! apps/server/src/provider/AntigravityProvider.ts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use goat2_contracts::{
    ProviderOptionDescriptor, ProviderProbeResult, ServerProviderAuthStatus, ServerProviderCli,
    ServerProviderState,
};
use goat2_engine_acp::agents::antigravity::Antigravity;
use goat2_engine_acp::agents::antigravity_auth::{AntigravityAuthConfig, AntigravityAuthMethod};
use goat2_engine_acp::agents::{fx::Fx, grok::Grok};
use goat2_engine_acp::probe::ProbeConfig;
use goat2_engine_acp::probe::antigravity::{AUTH_UNCHECKED_MESSAGE, AntigravityProbeSettings};
use goat2_engine_acp::probe::minimax::{
    MiniMaxCodeQuotaReader, QuotaHttp, QuotaReading, QuotaRequest, QuotaResponse,
};
use goat2_engine_acp::probe::registry::check_registry_provider_status;
use goat2_engine_acp::registry::RegistryAgentFlavor;
use goat2_engine_acp::registry::index::{RegistrySettings, Source};
use goat2_engine_acp::{AcpEngineFactory, LaunchCommand};
use goat2_engine_api::{EngineFactory, LaunchSpec};
use serde_json::{Value, json};

const MOCK: &str = env!("CARGO_BIN_EXE_goat2-acp-mock-agent");

fn env_of(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn registry_factory(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    local: bool,
) -> AcpEngineFactory {
    let mut command = LaunchCommand::new(program, args.iter().copied());
    command.env = env_of(env);
    AcpEngineFactory::new(Arc::new(RegistryAgentFlavor::new("mock", command, local)))
}

fn config(dir: &Path) -> ProbeConfig {
    ProbeConfig {
        cwd: Some(dir.to_path_buf()),
        ..Default::default()
    }
}

async fn probe(factory: AcpEngineFactory, config: ProbeConfig) -> ProviderProbeResult {
    factory
        .with_probe_config(config)
        .probe()
        .await
        .expect("ACP probes report failures in the result")
}

fn descriptor_ids(result: &ProviderProbeResult, slug: &str) -> Vec<String> {
    result
        .models
        .iter()
        .find(|m| m.slug == slug)
        .and_then(|m| m.capabilities.as_ref())
        .and_then(|c| c.option_descriptors.as_ref())
        .map(|d| {
            d.iter()
                .map(|d| match d {
                    ProviderOptionDescriptor::Select { id, .. }
                    | ProviderOptionDescriptor::Boolean { id, .. } => id.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn logged_messages(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

// ---- registry agents ----------------------------------------------------------------------

/// v1 driverSnapshots.ts:180-187: a probe session proves the agent runs, not that it is signed in.
#[tokio::test]
async fn registry_agent_ready_with_live_models() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_THOUGHT_LEVEL", "1"),
            ("GOAT_ACP_LOGOUT", "1"),
            ("GOAT_ACP_SESSION_DELETE", "1"),
            ("GOAT_ACP_AGENT_VERSION", "2.0.0"),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ],
        false,
    );
    let result = probe(
        factory,
        ProbeConfig {
            registry_version: Some("1.0.0".into()),
            ..config(dir.path())
        },
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert!(result.installed);
    assert_eq!(result.version.as_deref(), Some("1.0.0"));
    assert_eq!(result.binary_path.as_deref(), Some(MOCK));
    assert_eq!(result.message, None);
    assert_eq!(result.auth.status, ServerProviderAuthStatus::Unknown);
    assert_eq!(result.auth.can_logout, Some(true));
    let slugs: Vec<&str> = result.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["mock-default", "mock-fast"]);
    assert_eq!(result.models[0].is_default, Some(true));
    assert_eq!(result.models[0].name, "Mock Default");
    // The current model has its thought level and the mode control; others the shared mode only.
    assert_eq!(
        descriptor_ids(&result, "mock-default"),
        ["effort", "_t3/session-mode"]
    );
    assert_eq!(descriptor_ids(&result, "mock-fast"), ["_t3/session-mode"]);
    assert!(result.checked_at.ends_with('Z') && result.checked_at.len() == 24);
    let methods: Vec<String> = logged_messages(&log)
        .iter()
        .filter_map(|m| m.get("method").and_then(Value::as_str).map(str::to_owned))
        .collect();
    assert!(!methods.contains(&"authenticate".to_owned()));
    assert!(methods.contains(&"session/delete".to_owned()));
}

/// v1 driverSnapshots.ts:176-179: a local agent shows the version it reports.
#[tokio::test]
async fn local_agent_reports_its_initialize_version() {
    let dir = tempfile::tempdir().unwrap();
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_AGENT_VERSION", " 2.0.0 "),
        ],
        true,
    );
    let result = probe(
        factory,
        ProbeConfig {
            registry: Some(RegistrySettings {
                source: Source::Local,
                ..Default::default()
            }),
            ..config(dir.path())
        },
    )
    .await;
    assert_eq!(result.version.as_deref(), Some("2.0.0"));
    assert_eq!(result.auth.can_logout, Some(false));
}

/// v1 probe.ts:498-543: agents that send their catalog after setup are waited for.
#[tokio::test]
async fn registry_agent_models_advertised_after_setup() {
    let dir = tempfile::tempdir().unwrap();
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_LATE_MODELS", "1"),
        ],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    let slugs: Vec<&str> = result.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["mock-default", "mock-fast"], "{result:?}");
}

/// v1 probe.ts:236-264: without a model select, ACP session models with `_meta` reasoning levels.
#[tokio::test]
async fn registry_agent_session_models_with_reasoning_meta() {
    let dir = tempfile::tempdir().unwrap();
    let models = json!({"currentModelId": "m1", "availableModels": [
        {"modelId": "m1", "name": "One", "_meta": {"reasoningEfforts": [{"value": "low"}, {"value": "high"}], "reasoningEffort": "high"}},
        {"modelId": "m2", "name": "Two", "_meta": {"supportsReasoningEffort": false}}
    ]})
    .to_string();
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_NO_MODEL_OPTION", "1"),
            ("GOAT_ACP_THOUGHT_LEVEL", "1"),
            ("GOAT_ACP_SESSION_MODELS", &models),
        ],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    let slugs: Vec<&str> = result.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["m1", "m2"], "{result:?}");
    assert_eq!(result.models[0].is_default, Some(true));
    // m1's own levels replace the session's; m2 opts out of reasoning.
    let descriptors = result.models[0]
        .capabilities
        .as_ref()
        .unwrap()
        .option_descriptors
        .as_ref()
        .unwrap();
    let levels = descriptors
        .iter()
        .find_map(|d| match d {
            ProviderOptionDescriptor::Select {
                id,
                options,
                current_value,
                ..
            } if id == "effort" => Some((
                options.iter().map(|o| o.id.clone()).collect::<Vec<_>>(),
                current_value.clone(),
            )),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        levels,
        (
            vec!["low".to_owned(), "high".to_owned()],
            Some("high".to_owned())
        )
    );
    assert_eq!(descriptor_ids(&result, "m2"), ["_t3/session-mode"]);
}

/// v1 driverSnapshots.ts:151-167,188-197: an agent that needs a sign-in names its method.
#[tokio::test]
async fn registry_agent_auth_required_env_var_method() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let methods = json!([
        {"id": "mock-key", "name": "API key", "type": "env_var", "vars": [{"name": "MOCK_API_KEY"}], "link": "https://example.com/keys"}
    ])
    .to_string();
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_AUTH_REQUIRED", "1"),
            ("GOAT_ACP_AUTH_METHODS", &methods),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    assert_eq!(result.status, ServerProviderState::Warning, "{result:?}");
    assert!(result.installed);
    assert_eq!(
        result.auth.status,
        ServerProviderAuthStatus::Unauthenticated
    );
    assert_eq!(result.auth.auth_type.as_deref(), Some("env_var"));
    assert_eq!(result.auth.label.as_deref(), Some("API key"));
    assert_eq!(
        result.message.as_deref(),
        Some(
            "Set MOCK_API_KEY under this instance's environment variables in provider settings. GOAT will detect it on the next provider refresh."
        )
    );
    assert_eq!(result.models[0].slug, "default");
    assert!(
        !logged_messages(&log)
            .iter()
            .any(|m| m.get("method") == Some(&json!("authenticate")))
    );
}

#[tokio::test]
async fn registry_agent_auth_required_agent_method() {
    let dir = tempfile::tempdir().unwrap();
    let factory = registry_factory(
        MOCK,
        &[],
        &[("GOAT_ACP_AUTH_METHOD_ID", "mock-login")],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    assert_eq!(
        result.auth.status,
        ServerProviderAuthStatus::Unauthenticated
    );
    assert_eq!(result.auth.auth_type.as_deref(), Some("agent"));
    assert_eq!(
        result.message.as_deref(),
        Some("Sign in in provider settings using \"Mock agent authentication\".")
    );
}

/// v1 snapshotReadiness.ts:35-44: a command that is not there.
#[tokio::test]
async fn registry_agent_missing_binary() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing-agent");
    let result = probe(
        registry_factory(missing.to_str().unwrap(), &[], &[], false),
        config(dir.path()),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Error);
    assert!(!result.installed && result.binary_path.is_none());
    assert_eq!(
        result.message.as_deref(),
        Some("ACP executable 'missing-agent' is not available on this environment's PATH.")
    );
    let local = probe(
        registry_factory(missing.to_str().unwrap(), &[], &[], true),
        ProbeConfig {
            registry: Some(RegistrySettings {
                source: Source::Local,
                ..Default::default()
            }),
            ..config(dir.path())
        },
    )
    .await;
    assert_eq!(
        local.message.as_deref(),
        Some("Local ACP executable is not available on this environment's PATH.")
    );
}

/// v1 probeHelpers.ts:39-51 and driverSnapshots.ts:180-181: an agent that dies before setup is a
/// failed discovery, a warning.
#[tokio::test]
async fn registry_agent_crash_at_start() {
    let dir = tempfile::tempdir().unwrap();
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EXIT_AT_START", "3"),
            ("GOAT_ACP_STDERR_LINE", "panic: boom"),
        ],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    assert_eq!(result.status, ServerProviderState::Warning, "{result:?}");
    assert!(result.installed);
    assert_eq!(result.auth.status, ServerProviderAuthStatus::Unknown);
    assert_eq!(
        result.message.as_deref(),
        Some("The ACP agent could not create a test session.")
    );
}

/// The probe looks for the agent where and as it will run it: a relative path in the configured
/// working directory, and only an executable file on PATH (v1 AntigravityInstallationLookup.ts:60-70
/// checks the execute bit; final review finding 19).
#[cfg(unix)]
#[tokio::test]
async fn registry_probe_resolves_the_agent_as_it_will_run() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(MOCK, dir.path().join("agent")).unwrap();
    let result = probe(
        registry_factory("./agent", &[], &[], true),
        config(dir.path()),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert_eq!(
        result.binary_path.as_deref().map(Path::new),
        Some(dir.path().join("agent").as_path())
    );

    let plain = dir.path().join("plain");
    let runnable = dir.path().join("runnable");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::create_dir_all(&runnable).unwrap();
    std::fs::write(plain.join("mock-agent"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(
        plain.join("mock-agent"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    std::os::unix::fs::symlink(MOCK, runnable.join("mock-agent")).unwrap();
    let path = format!("{}:{}", plain.display(), runnable.display());
    let result = probe(
        registry_factory("mock-agent", &[], &[("PATH", &path)], true),
        config(dir.path()),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert_eq!(
        result.binary_path.as_deref().map(Path::new),
        Some(runnable.join("mock-agent").as_path())
    );
}

#[tokio::test]
async fn disabled_instances_run_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("argv.json");
    let factory = registry_factory(
        MOCK,
        &[],
        &[("GOAT_ACP_ARGV_LOG_PATH", log.to_str().unwrap())],
        false,
    );
    let result = probe(
        factory,
        ProbeConfig {
            enabled: false,
            ..config(dir.path())
        },
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Disabled);
    assert_eq!(
        result.message.as_deref(),
        Some("ACP Registry is disabled in GOAT settings.")
    );
    assert!(!log.exists());
}

/// v1 snapshotReadiness.ts:13-20: a registry instance without an agent.
#[tokio::test]
async fn registry_instance_without_agent_is_unconfigured() {
    let dir = tempfile::tempdir().unwrap();
    let factory = AcpEngineFactory::new(Arc::new(RegistryAgentFlavor::new(
        String::new(),
        LaunchCommand::new(MOCK, Vec::<String>::new()),
        false,
    )));
    let result = probe(factory, config(dir.path())).await;
    assert_eq!(result.status, ServerProviderState::Warning);
    assert!(!result.installed);
    assert_eq!(
        result.message.as_deref(),
        Some(
            "Select an ACP Registry agent or configure a local ACP executable before starting a thread."
        )
    );
}

struct NoNetwork(std::sync::atomic::AtomicUsize);

#[async_trait::async_trait]
impl QuotaHttp for NoNetwork {
    async fn send(&self, _request: QuotaRequest) -> Option<QuotaResponse> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        None
    }
}

/// v1 minimaxCodeUsageEnrichment.ts:37-58: the quota is read only for `mcode acp` with the setting on
/// and an explicit profile; a profile that is not there reads as signed out.
#[tokio::test]
async fn minimax_quota_is_read_only_under_v1_conditions() {
    let dir = tempfile::tempdir().unwrap();
    let http = Arc::new(NoNetwork(Default::default()));
    let reader = MiniMaxCodeQuotaReader::new(http.clone());
    let settings = |read: bool| RegistrySettings {
        source: Source::Local,
        command_path: "/usr/local/bin/mcode".into(),
        command_args: vec!["acp".into()],
        read_mini_max_code_quota: read,
        ..Default::default()
    };
    let status = |read: bool| {
        let mut config = cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_EMIT_COMMANDS", "1"),
                ("MINIMAX_DATA_DIR", "/goat2-test-no-such-profile"),
            ],
        );
        config.registry = Some(settings(read));
        if let Some(launch) = config.launch.as_mut() {
            launch.args = vec!["acp".into()];
        }
        config
    };
    let factory = registry_factory(MOCK, &["acp"], &[], true);
    let on = check_registry_provider_status(&factory, &status(true), Some(&reader)).await;
    assert_eq!(on.usage, Some(QuotaReading::SignedOut));
    assert_eq!(
        on.provider.status,
        ServerProviderState::Ready,
        "{:?}",
        on.provider
    );
    let off = check_registry_provider_status(&factory, &status(false), Some(&reader)).await;
    assert_eq!(off.usage, None);
    assert_eq!(http.0.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// v1 deepSeekProbeHistory.ts: `dsh acp` gets a temporary history patch that is removed afterwards.
#[cfg(unix)]
#[tokio::test]
async fn deepseek_probe_history_is_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let dsh = dir.path().join("dsh");
    std::os::unix::fs::symlink(MOCK, &dsh).unwrap();
    let log = dir.path().join("argv.json");
    let factory = registry_factory(
        dsh.to_str().unwrap(),
        &["acp"],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_ARGV_LOG_PATH", log.to_str().unwrap()),
        ],
        false,
    );
    let result = probe(factory, config(dir.path())).await;
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(&log).unwrap()).unwrap();
    let argv: Vec<String> = serde_json::from_value(seen["argv"].clone()).unwrap();
    assert_eq!(argv[0], "acp");
    assert_eq!(argv[1], "--patch");
    let patch: Value = serde_json::from_str(seen["patch"].as_str().unwrap()).unwrap();
    assert_eq!(patch[1]["id"], "session-projection-cache");
    assert!(
        !Path::new(&argv[2]).exists(),
        "the temporary history must be removed"
    );
}

/// v1 modelDiscovery.ts: each requested model is opened once for its own options, then the
/// original model is selected again.
#[tokio::test]
async fn model_discovery_reads_per_model_options() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let factory = registry_factory(
        MOCK,
        &[],
        &[
            ("GOAT_ACP_EMIT_COMMANDS", "1"),
            ("GOAT_ACP_THOUGHT_LEVEL", "1"),
            ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
        ],
        false,
    );
    let result = probe(
        factory,
        ProbeConfig {
            discover_models: vec!["mock-fast".into(), "not-offered".into()],
            ..config(dir.path())
        },
    )
    .await;
    assert_eq!(
        descriptor_ids(&result, "mock-fast"),
        ["_t3/session-mode", "effort"]
    );
    let writes: Vec<String> = logged_messages(&log)
        .iter()
        .filter(|m| m.get("method") == Some(&json!("session/set_config_option")))
        .map(|m| m["params"]["value"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(writes, ["mock-fast", "mock-default"]);
}

// ---- Grok -----------------------------------------------------------------------------------

fn cli_config(dir: &Path, binary: &str, env: &[(&str, &str)]) -> ProbeConfig {
    ProbeConfig {
        launch: Some(LaunchSpec {
            binary: Some(PathBuf::from(binary)),
            args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
        }),
        ..config(dir)
    }
}

fn grok() -> AcpEngineFactory {
    AcpEngineFactory::new(Arc::new(Grok::default()))
}

fn cli_calls(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// v1 grok status.ts:533-622: CLI version and login, models from ACP initialize only.
#[tokio::test]
async fn grok_ready_with_initialize_models() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("cli.log");
    let meta = json!({"modelState": {"currentModelId": "grok-build", "availableModels": [
        {"modelId": "grok-build", "name": "Grok Build", "_meta": {"reasoningEfforts": [{"value": "high"}, {"value": "low", "default": true}]}},
        {"modelId": "grok-4", "name": "Grok 4"}
    ]}})
    .to_string();
    let result = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_VERSION", "grok 1.0.52"),
                (
                    "GOAT_ACP_MOCK_CLI_MODELS",
                    "You are logged in.\n  * grok-build (default)",
                ),
                ("GOAT_ACP_INITIALIZE_META", &meta),
                ("GOAT_ACP_MOCK_CLI_LOG_PATH", log.to_str().unwrap()),
            ],
        ),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert_eq!(result.cli, Some(ServerProviderCli::Present));
    assert_eq!(result.version.as_deref(), Some("1.0.52"));
    assert_eq!(result.auth.status, ServerProviderAuthStatus::Authenticated);
    assert_eq!(result.auth.auth_type.as_deref(), Some("cached_token"));
    assert_eq!(result.auth.label.as_deref(), Some("Grok account"));
    let slugs: Vec<&str> = result.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["grok-build", "grok-4"]);
    assert_eq!(descriptor_ids(&result, "grok-build"), ["reasoningEffort"]);
    assert_eq!(cli_calls(&log), ["--version", "models ", "acp agent stdio"]);
}

/// v1 grok status.ts:535-542,588-605: a logged-out line is checked once more before it counts.
#[tokio::test]
async fn grok_logged_out_after_recheck() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("cli.log");
    let result = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_MODELS", "Not logged in"),
                ("GOAT_ACP_MOCK_CLI_LOG_PATH", log.to_str().unwrap()),
            ],
        ),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Error);
    assert_eq!(
        result.auth.status,
        ServerProviderAuthStatus::Unauthenticated
    );
    assert_eq!(
        result.message.as_deref(),
        Some("Grok CLI is installed but not logged in. Add an xAI API key, or run `grok login`.")
    );
    assert_eq!(
        cli_calls(&log)
            .iter()
            .filter(|c| c.starts_with("models"))
            .count(),
        2
    );

    // A refreshed token answers the second call as logged in.
    let log = dir.path().join("cli2.log");
    let result = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_MODELS", "Not logged in"),
                (
                    "GOAT_ACP_MOCK_CLI_MODELS_2",
                    "You are logged in\n* grok-build",
                ),
                ("GOAT_ACP_MOCK_CLI_LOG_PATH", log.to_str().unwrap()),
            ],
        ),
    )
    .await;
    assert_eq!(result.auth.status, ServerProviderAuthStatus::Authenticated);
    // No ACP model state: the CLI's list, and ready.
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert_eq!(result.models[0].slug, "grok-build");
}

/// v1 grok status.ts:544-545: an xAI API key is the sign-in; no recheck.
#[tokio::test]
async fn grok_api_key_authenticates() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("cli.log");
    let result = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("XAI_API_KEY", "test-key-not-real"),
                ("GOAT_ACP_MOCK_CLI_MODELS", "not logged in"),
                ("GOAT_ACP_MOCK_CLI_LOG_PATH", log.to_str().unwrap()),
            ],
        ),
    )
    .await;
    assert_eq!(result.auth.status, ServerProviderAuthStatus::Authenticated);
    assert_eq!(result.auth.auth_type.as_deref(), Some("api_key"));
    assert_eq!(result.auth.label.as_deref(), Some("xAI API key"));
    assert_eq!(
        cli_calls(&log)
            .iter()
            .filter(|c| c.starts_with("models"))
            .count(),
        1
    );
    // No models anywhere: the built-in list, not ready.
    assert_eq!(result.status, ServerProviderState::Warning);
    assert_eq!(
        result.message.as_deref(),
        Some("Grok CLI did not list any models. Model options may be incomplete.")
    );
    assert_eq!(result.models[0].slug, "grok-build");
}

#[tokio::test]
async fn grok_missing_binary_and_failed_version() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("grok");
    let result = probe(
        grok(),
        cli_config(dir.path(), missing.to_str().unwrap(), &[]),
    )
    .await;
    assert!(!result.installed);
    assert_eq!(result.cli, Some(ServerProviderCli::Missing));
    assert_eq!(result.status, ServerProviderState::Error);
    assert!(
        result
            .message
            .as_deref()
            .unwrap()
            .starts_with("Grok CLI (`grok`) is not installed or not on PATH."),
        "{result:?}"
    );

    let failed = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_VERSION_EXIT", "2"),
            ],
        ),
    )
    .await;
    assert!(failed.installed);
    assert_eq!(failed.cli, Some(ServerProviderCli::Present));
    assert_eq!(
        failed.message.as_deref(),
        Some("Grok CLI is installed but failed to run.")
    );
}

/// v1 grok status.ts:569-586: an agent that dies before `initialize` leaves the CLI models, a warning.
#[tokio::test]
async fn grok_initialize_failure_is_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let result = probe(
        grok(),
        cli_config(
            dir.path(),
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                (
                    "GOAT_ACP_MOCK_CLI_MODELS",
                    "You are logged in\n* grok-code-fast",
                ),
                ("GOAT_ACP_EXIT_AT_START", "1"),
            ],
        ),
    )
    .await;
    assert_eq!(result.status, ServerProviderState::Warning);
    assert_eq!(
        result.message.as_deref(),
        Some("Grok CLI is installed but ACP initialize failed. Model options may be incomplete.")
    );
    assert_eq!(result.models[0].slug, "grok-code-fast");
    assert_eq!(result.models[0].name, "Grok code fast");
}

// ---- fx -------------------------------------------------------------------------------------

fn fx() -> AcpEngineFactory {
    AcpEngineFactory::new(Arc::new(Fx::default()))
}

async fn fx_with(dir: &Path, status: &str, models: &str) -> ProviderProbeResult {
    probe(
        fx(),
        cli_config(
            dir,
            MOCK,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_VERSION", "fx 0.0.13"),
                ("GOAT_ACP_MOCK_CLI_STATUS", status),
                ("GOAT_ACP_MOCK_CLI_MODELS", models),
            ],
        ),
    )
    .await
}

/// v1 fx status.ts:221-256.
#[tokio::test]
async fn fx_status_rules() {
    let dir = tempfile::tempdir().unwrap();
    let ready = fx_with(
        dir.path(),
        r#"{"auth":"oauth","model":"fx-1"}"#,
        r#"{"ids":["fx-1","fx-2"]}"#,
    )
    .await;
    assert_eq!(ready.status, ServerProviderState::Ready, "{ready:?}");
    assert_eq!(ready.version.as_deref(), Some("0.0.13"));
    assert_eq!(ready.auth.label.as_deref(), Some("oauth"));
    let slugs: Vec<&str> = ready.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["default", "fx-1", "fx-2"]);
    assert_eq!(ready.models[0].name, "Default (fx-1)");
    assert_eq!(descriptor_ids(&ready, "fx-2"), ["effort"]);

    let signed_out = fx_with(dir.path(), r#"{"auth":"missing"}"#, r#"{"ids":[]}"#).await;
    assert_eq!(signed_out.status, ServerProviderState::Error);
    assert_eq!(
        signed_out.auth.status,
        ServerProviderAuthStatus::Unauthenticated
    );
    assert_eq!(
        signed_out.message.as_deref(),
        Some("Run `fx login` to sign in.")
    );

    let unknown = fx_with(dir.path(), "", r#"{"ids":[]}"#).await;
    assert_eq!(unknown.status, ServerProviderState::Warning);
    assert_eq!(
        unknown.message.as_deref(),
        Some("fx is installed but login state could not be determined.")
    );

    let unlisted = fx_with(dir.path(), r#"{"auth":"oauth"}"#, "oops").await;
    assert_eq!(unlisted.status, ServerProviderState::Warning);
    assert_eq!(
        unlisted.message.as_deref(),
        Some("fx is installed but model listing failed. Model options may be incomplete.")
    );

    let missing = probe(
        fx(),
        cli_config(dir.path(), dir.path().join("fx").to_str().unwrap(), &[]),
    )
    .await;
    assert!(!missing.installed);
    assert_eq!(missing.cli, None);
    assert!(
        missing
            .message
            .as_deref()
            .unwrap()
            .starts_with("fx is not installed or not on PATH.")
    );
}

// ---- Antigravity ----------------------------------------------------------------------------

/// v1 AntigravityDriver.ts:661-726 and AntigravityProvider.ts:398-460: the check resolves the
/// runtime without starting it; sign-in is unknown until a session confirms it.
#[tokio::test]
async fn antigravity_resolves_without_starting() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("argv.json");
    let factory = || AcpEngineFactory::new(Arc::new(Antigravity::default()));
    let found = probe(
        factory(),
        cli_config(
            dir.path(),
            MOCK,
            &[("GOAT_ACP_ARGV_LOG_PATH", log.to_str().unwrap())],
        ),
    )
    .await;
    assert!(found.installed);
    assert_eq!(found.status, ServerProviderState::Warning);
    assert_eq!(found.message.as_deref(), Some(AUTH_UNCHECKED_MESSAGE));
    assert_eq!(found.auth.status, ServerProviderAuthStatus::Unknown);
    assert_eq!(found.auth.auth_type.as_deref(), Some("oauth-personal"));
    assert_eq!(found.binary_path.as_deref(), Some(MOCK));
    assert!(!log.exists(), "the probe must not start the runtime");

    let missing = probe(
        factory(),
        cli_config(dir.path(), dir.path().join("agy").to_str().unwrap(), &[]),
    )
    .await;
    assert!(!missing.installed);
    assert_eq!(missing.status, ServerProviderState::Error);
    assert!(
        missing
            .message
            .as_deref()
            .unwrap()
            .starts_with("The custom Antigravity executable is missing")
    );

    // The flavor carries the key it launches with (synthetic here); the probe sees only whether
    // the settings hold one.
    let key = |api_key: &str| {
        AcpEngineFactory::new(Arc::new(Antigravity {
            auth: AntigravityAuthConfig {
                auth_method: AntigravityAuthMethod::GeminiApiKey,
                api_key: api_key.into(),
                ..Default::default()
            },
            ..Default::default()
        }))
    };
    let unset = probe(key(""), cli_config(dir.path(), MOCK, &[])).await;
    assert_eq!(unset.status, ServerProviderState::Error);
    assert_eq!(
        unset.message.as_deref(),
        Some("Enter a Gemini API key in the Antigravity provider settings.")
    );
    let set = probe(
        key("test-key"),
        ProbeConfig {
            antigravity: AntigravityProbeSettings {
                api_key_set: true,
                ..Default::default()
            },
            ..cli_config(dir.path(), MOCK, &[])
        },
    )
    .await;
    assert_eq!(
        set.message.as_deref(),
        Some("Antigravity is installed. Connect with Gemini API key to load models.")
    );
    assert_eq!(set.auth.auth_type.as_deref(), Some("gemini-api-key"));
}

/// Every flavor answers through the trait method.
#[tokio::test]
async fn probe_is_the_engine_factory_method() {
    let factory: Box<dyn EngineFactory> = Box::new(grok().with_probe_config(ProbeConfig {
        enabled: false,
        ..Default::default()
    }));
    let result = factory.probe().await.unwrap();
    assert_eq!(result.status, ServerProviderState::Disabled);
    assert_eq!(
        result.message.as_deref(),
        Some("Grok is disabled in GOAT settings.")
    );
}

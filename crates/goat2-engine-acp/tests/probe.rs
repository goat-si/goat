//! Provider probes against the fake agent: no sign-in, advertised commands, session cleanup.
//! v1 packages/provider-acp-registry/src/server/probe.ts:410-546.

use std::sync::Arc;

use goat2_contracts::{
    EngineConfig, EngineDriver, ModelSelection, ProviderInstanceId, RuntimeMode,
};
use goat2_engine_acp::{AcpEngineFactory, AcpFlavor, LaunchCommand, McpBridgeCommand};
use goat2_engine_api::{EngineError, McpEndpoint, SessionSpec};
use serde_json::Value;

struct Mock(Vec<(String, String)>);

impl AcpFlavor for Mock {
    fn driver(&self) -> &str {
        "acpRegistry"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::AcpRegistry {
            agent_id: "mock".into(),
        }
    }
    fn launch(&self, _spec: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let mut command = LaunchCommand::new(
            env!("CARGO_BIN_EXE_goat2-acp-mock-agent"),
            Vec::<String>::new(),
        );
        command.env = self.0.clone();
        Ok(command)
    }
}

fn factory(env: &[(&str, &str)]) -> AcpEngineFactory {
    AcpEngineFactory::new(Arc::new(Mock(
        env.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )))
    .with_mcp_bridge(McpBridgeCommand::new(
        "/goat2-test/bin/goat2-acp-mcp-bridge",
        Vec::<String>::new(),
    ))
    .for_probe()
}

fn spec(cwd: &std::path::Path) -> SessionSpec {
    SessionSpec {
        thread_id: "probe".into(),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("mock"),
            model_selection: ModelSelection {
                instance_id: ProviderInstanceId::new("mock"),
                model: "default".into(),
                options: None,
            },
            runtime_mode: RuntimeMode::ApprovalRequired,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "t".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    }
}

fn methods(log: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|m| m.get("method").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// v1 probe: authenticateOnAuthRequired false; the failure keeps the advertised sign-in methods.
#[tokio::test]
async fn probe_never_signs_in() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let failure = match factory(&[
        ("GOAT_ACP_AUTH_METHOD_ID", "mock-login"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ])
    .open_probe(spec(dir.path()))
    .await
    {
        Ok(_) => panic!("probe opened a session that needs a sign-in"),
        Err(failure) => failure,
    };
    assert!(failure.auth_required, "{failure:?}");
    assert_eq!(failure.auth_methods[0].id, "mock-login");
    assert!(!methods(&log).contains(&"authenticate".to_owned()));
}

/// The probe reads the advertised commands and deletes its session when the agent supports it.
#[tokio::test]
async fn probe_reads_commands_and_deletes_its_session() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let probe = factory(&[
        ("GOAT_ACP_EMIT_COMMANDS", "1"),
        ("GOAT_ACP_SESSION_DELETE", "1"),
        ("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap()),
    ])
    .open_probe(spec(dir.path()))
    .await
    .expect("probe");
    let commands = probe
        .session
        .available_commands()
        .expect("commands advertised");
    assert_eq!(commands[0]["name"], "review");
    assert!(probe.session.session_setup().config_options.len() > 0);
    probe.close().await;
    assert!(methods(&log).contains(&"session/delete".to_owned()));
}

/// No session/delete to an agent that does not advertise it (v1 AcpSessionRuntime.ts:1902-1915);
/// without commands the probe still opens after the grace period.
#[tokio::test]
async fn probe_skips_delete_when_not_advertised() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("log.jsonl");
    let probe = factory(&[("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap())])
        .open_probe(spec(dir.path()))
        .await
        .expect("probe");
    assert!(probe.session.available_commands().is_none());
    probe.close().await;
    assert!(!methods(&log).contains(&"session/delete".to_owned()));
}

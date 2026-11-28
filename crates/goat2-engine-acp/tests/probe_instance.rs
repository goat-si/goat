//! `EngineFactory::probe_instance` and per-instance homes through the real factory with the fake agent:
//! an instance's launch settings apply to its probe as `SessionSpec.launch` applies to its sessions,
//! and an instance's private home holds the per-account state the driver keeps (the Antigravity
//! profile), for probes and sessions alike.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use goat2_contracts::{
    EngineConfig, ModelSelection, ProviderInstanceId, RuntimeMode, ServerProviderState,
};
use goat2_engine_acp::agents::antigravity::{
    Antigravity, AntigravityInstallation, AntigravityLaunch,
};
use goat2_engine_acp::agents::antigravity_auth::AntigravityProfile;
use goat2_engine_acp::agents::grok::Grok;
use goat2_engine_acp::probe::ProbeConfig;
use goat2_engine_acp::registry::RegistryAgentFlavor;
use goat2_engine_acp::{AcpEngineFactory, LaunchCommand};
use goat2_engine_api::{EngineFactory, LaunchSpec, McpEndpoint, ProviderTarget, SessionSpec};
use serde_json::Value;

const MOCK: &str = env!("CARGO_BIN_EXE_goat2-acp-mock-agent");

fn launch(binary: Option<&str>, env: &[(&str, &str)]) -> LaunchSpec {
    LaunchSpec {
        binary: binary.map(PathBuf::from),
        args: Vec::new(),
        env: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn target(launch: Option<LaunchSpec>, home: Option<&Path>) -> ProviderTarget {
    ProviderTarget {
        instance_id: ProviderInstanceId::new("second"),
        launch,
        home: home.map(Path::to_path_buf),
        shared_home: None,
    }
}

fn antigravity(executable: &str, profile: &Path) -> Antigravity {
    Antigravity {
        launch: Some(AntigravityLaunch {
            installation: AntigravityInstallation::external(PathBuf::from(executable)),
            profile: AntigravityProfile::new(profile, "true".into()),
            runtime_temp_directory: None,
            base_env: Some(Default::default()),
        }),
        ..Default::default()
    }
}

/// The instance's binary replaces the factory's, and its variables go over the factory's probe
/// launch: the factory's own probe (no instance) still finds nothing.
#[tokio::test]
async fn the_instance_launch_applies_to_a_cli_probe() {
    let dir = tempfile::tempdir().unwrap();
    let factory = AcpEngineFactory::new(Arc::new(Grok {
        binary_path: Some("/goat2-no/grok".into()),
        ..Default::default()
    }))
    .with_probe_config(ProbeConfig {
        cwd: Some(dir.path().to_path_buf()),
        launch: Some(launch(
            None,
            &[
                ("GOAT_ACP_MOCK_CLI", "1"),
                ("GOAT_ACP_MOCK_CLI_VERSION", "grok 1.0.1"),
                (
                    "GOAT_ACP_MOCK_CLI_MODELS",
                    "You are logged in.\n  * grok-build (default)",
                ),
            ],
        )),
        ..Default::default()
    });
    let own = factory.probe().await.unwrap();
    assert!(!own.installed, "{own:?}");

    let instance = factory
        .probe_instance(&target(
            Some(launch(
                Some(MOCK),
                &[("GOAT_ACP_MOCK_CLI_VERSION", "grok 1.0.52")],
            )),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(instance.status, ServerProviderState::Ready, "{instance:?}");
    assert_eq!(instance.version.as_deref(), Some("1.0.52"));
}

/// A registry agent's probe session starts the instance's program with its variables.
#[tokio::test]
async fn the_instance_launch_applies_to_a_probe_session() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("requests.jsonl");
    let factory = AcpEngineFactory::new(Arc::new(RegistryAgentFlavor::new(
        "mock",
        LaunchCommand::new("/goat2-no/agent", Vec::<String>::new()),
        false,
    )))
    .with_probe_config(ProbeConfig {
        cwd: Some(dir.path().to_path_buf()),
        ..Default::default()
    });
    let result = factory
        .probe_instance(&target(
            Some(launch(
                Some(MOCK),
                &[("GOAT_ACP_REQUEST_LOG_PATH", log.to_str().unwrap())],
            )),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(result.status, ServerProviderState::Ready, "{result:?}");
    assert_eq!(result.binary_path.as_deref(), Some(MOCK));
    assert!(
        std::fs::read_to_string(&log)
            .unwrap()
            .contains("\"initialize\"")
    );
}

/// An Antigravity instance's profile is prepared in its home (private folders, the sign-in
/// method in settings.json), never in the default profile, and the result names no home.
#[tokio::test]
async fn an_antigravity_probe_uses_the_instance_home() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("default-profile");
    let home = dir.path().join("second-home");
    std::fs::create_dir_all(&home).unwrap();
    let factory = AcpEngineFactory::new(Arc::new(antigravity(MOCK, &base)));
    let result = factory
        .probe_instance(&target(None, Some(&home)))
        .await
        .unwrap();
    assert!(result.installed, "{result:?}");
    assert_eq!(result.binary_path.as_deref(), Some(MOCK));
    let settings = std::fs::read_to_string(home.join("antigravity-acp/settings.json")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&settings).unwrap()["auth"]["type"],
        "oauth-personal"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&home), 0o700);
        assert_eq!(mode(&home.join("antigravity-acp")), 0o700);
    }
    assert!(!base.exists(), "the default profile is left alone");
    let shown = format!("{result:?}");
    assert!(!shown.contains(home.to_str().unwrap()), "{shown}");
}

/// A session of that instance runs the agent with the profile in its home.
#[tokio::test]
async fn an_antigravity_session_uses_the_instance_home() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("default-profile");
    let home = dir.path().join("second-home");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let env_log = dir.path().join("env.json");
    let argv_log = dir.path().join("argv.json");
    let factory = AcpEngineFactory::new(Arc::new(antigravity("agy", &base)));
    let spec = SessionSpec {
        thread_id: "t".into(),
        engine: EngineConfig {
            provider_instance_id: "second".into(),
            model_selection: ModelSelection {
                instance_id: "second".into(),
                model: "default".into(),
                options: None,
            },
            runtime_mode: RuntimeMode::ApprovalRequired,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: String::new(),
            bearer_token: String::new(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        instance: Some(target(
            Some(launch(
                Some(MOCK),
                &[
                    ("GOAT_ACP_ANTIGRAVITY", "1"),
                    ("GOAT_ACP_ENV_LOG_PATH", env_log.to_str().unwrap()),
                    ("GOAT_ACP_ENV_LOG_NAMES", "GEMINI_HOME"),
                    ("GOAT_ACP_ARGV_LOG_PATH", argv_log.to_str().unwrap()),
                ],
            )),
            Some(&home),
        )),
    };
    let handle = factory.start(spec).await.expect("the session starts");
    handle.session.shutdown().await;
    let env: Value = serde_json::from_str(&std::fs::read_to_string(&env_log).unwrap()).unwrap();
    assert_eq!(env["GEMINI_HOME"], home.to_str().unwrap());
    let argv: Value = serde_json::from_str(&std::fs::read_to_string(&argv_log).unwrap()).unwrap();
    let argv: Vec<&str> = argv["argv"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(&argv[..3], ["acp", "--gemini-dir", home.to_str().unwrap()]);
    assert!(home.join("antigravity-acp/settings.json").is_file());
    assert!(!base.exists(), "the default profile is left alone");
}

/// The runtime runs alone when it is the agy CLI and with its harness otherwise (v1
/// isAntigravityCli, fromExternal).
#[test]
fn an_external_installation_finds_its_harness() {
    let cli = AntigravityInstallation::external("/opt/bin/agy".into());
    assert_eq!(cli.harness_path, None);
    assert_eq!(
        AntigravityInstallation::external("/opt/bin/Antigravity.exe".into()).harness_path,
        None
    );
    let runtime = AntigravityInstallation::external("/opt/agy/agy_acp_server".into());
    assert_eq!(
        runtime.harness_path,
        Some(PathBuf::from("/opt/agy").join(goat2_engine_acp::agents::antigravity::HARNESS_FILE))
    );
    assert!(!runtime.managed && runtime.version.is_none());
}

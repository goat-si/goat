//! Probe against the fake CLI's `--version` and `auth status`.

use std::path::PathBuf;

use goat2_contracts::{ServerProviderAuthStatus, ServerProviderCli, ServerProviderState};
use goat2_engine_api::{EngineFactory, ProviderTarget};
use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};

fn factory(logged_in: bool) -> ClaudeEngineFactory {
    let mut options = ClaudeEngineOptions::default();
    options.launch.binary = PathBuf::from(env!("CARGO_BIN_EXE_goat2-fake-claude"));
    if logged_in {
        options.launch.env = vec![("GOAT2_FAKE_CLAUDE_LOGGED_IN".into(), "1".into())];
    }
    ClaudeEngineFactory::new(options)
}

#[tokio::test]
async fn signed_in_cli_is_ready_with_models() {
    let probe = factory(true).probe().await.unwrap();
    assert!(probe.installed);
    assert_eq!(probe.version.as_deref(), Some("2.1.332"));
    assert_eq!(probe.cli, Some(ServerProviderCli::Present));
    assert_eq!(probe.status, ServerProviderState::Ready);
    assert_eq!(probe.auth.status, ServerProviderAuthStatus::Authenticated);
    let default: Vec<&str> = probe
        .models
        .iter()
        .filter(|m| m.is_default == Some(true))
        .map(|m| m.slug.as_str())
        .collect();
    assert_eq!(default, vec!["claude-opus-5-5"]);
    let opus = probe
        .models
        .iter()
        .find(|m| m.slug == "claude-opus-5-5")
        .unwrap();
    assert_eq!(opus.name, "Claude Opus 5.5");
    assert!(
        opus.capabilities.is_some(),
        "profile capabilities come along"
    );
}

#[tokio::test]
async fn signed_out_cli_is_an_error_with_v1_message() {
    let probe = factory(false).probe().await.unwrap();
    assert_eq!(probe.auth.status, ServerProviderAuthStatus::Unauthenticated);
    assert_eq!(probe.status, ServerProviderState::Error);
    assert_eq!(
        probe.message.as_deref(),
        Some("Claude Code is not authenticated. Run `claude auth login` and try again.")
    );
}

#[tokio::test]
async fn missing_cli_is_not_installed() {
    let mut options = ClaudeEngineOptions::default();
    options.launch.binary = PathBuf::from("/nonexistent/claude");
    let probe = ClaudeEngineFactory::new(options).probe().await.unwrap();
    assert!(!probe.installed);
    assert_eq!(probe.cli, Some(ServerProviderCli::Missing));
    assert!(probe.models.is_empty());
}

#[test]
fn models_follow_the_cli_version() {
    let old = goat2_engine_claude::probe::manifest_models(Some("2.1.200"));
    assert!(
        !old.iter().any(|m| m.slug == "claude-opus-5-5"),
        "needs 2.1.280"
    );
    assert!(
        old.iter().any(|m| m.slug == "claude-opus-4-6"),
        "no minimum"
    );
}

fn target(home: Option<PathBuf>, shared_home: Option<PathBuf>) -> ProviderTarget {
    ProviderTarget {
        instance_id: "claudeAgent-work".into(),
        launch: None,
        home,
        shared_home,
    }
}

/// Each instance's sign-in is read from its own Claude home (CLAUDE_CONFIG_DIR): the shared home
/// a person set wins over the host's private folder, as v1 homePath does.
#[tokio::test]
async fn probe_instance_reads_the_instance_home() {
    let dir = std::env::temp_dir().join(format!("goat2-claude-probe-{}", std::process::id()));
    let signed_in = dir.join("signed-in");
    let signed_out = dir.join("signed-out");
    std::fs::create_dir_all(&signed_in).unwrap();
    std::fs::create_dir_all(&signed_out).unwrap();
    std::fs::write(signed_in.join("goat2-fake-signed-in"), "").unwrap();
    let factory = factory(false);
    let status = |probe: goat2_contracts::ProviderProbeResult| probe.auth.status;
    assert_eq!(
        status(
            factory
                .probe_instance(&target(Some(signed_in.clone()), None))
                .await
                .unwrap()
        ),
        ServerProviderAuthStatus::Authenticated
    );
    assert_eq!(
        status(
            factory
                .probe_instance(&target(Some(signed_out.clone()), None))
                .await
                .unwrap()
        ),
        ServerProviderAuthStatus::Unauthenticated
    );
    assert_eq!(
        status(
            factory
                .probe_instance(&target(Some(signed_out.clone()), Some(signed_in.clone())))
                .await
                .unwrap()
        ),
        ServerProviderAuthStatus::Authenticated,
        "shared_home wins"
    );
    let probe = factory
        .probe_instance(&target(Some(signed_out.clone()), None))
        .await
        .unwrap();
    let printed = format!("{probe:?}");
    assert!(
        !printed.contains("signed-out"),
        "home path leaked: {printed}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

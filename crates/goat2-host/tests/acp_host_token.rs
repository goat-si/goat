//! The host's UI bearer token (`GOAT2_HOST_TOKEN`) and GOAT's own identity never reach an ACP agent
//! started by a factory from `engine::acp`, from a session or a probe. Its own test binary: it sets
//! the variables in this process's environment, which the agents would otherwise inherit.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use goat2_contracts::{EngineConfig, ModelSelection, RuntimeMode};
use goat2_engine_api::{EngineFactory, McpEndpoint, SessionSpec};
use goat2_host::engine::acp::acp_factories;

/// A stand-in agent: records whether either variable reached it, then exits (the session start
/// fails at `initialize`, after the launch the test is about).
fn stand_in(dir: &Path, name: &str, log: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nif [ -z \"$GOAT2_HOST_TOKEN$GOAT_THREAD_ID\" ]; then echo absent; \
             else echo present; fi >> '{}'\nexit 1\n",
            log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn spec(cwd: &Path) -> SessionSpec {
    SessionSpec {
        thread_id: "t1".into(),
        engine: EngineConfig {
            provider_instance_id: "p".into(),
            model_selection: ModelSelection {
                instance_id: "p".into(),
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
        instance: None,
    }
}

#[tokio::test]
async fn the_host_token_never_reaches_an_acp_agent() {
    // SAFETY: the only test in this binary, before any thread reads the environment.
    unsafe {
        std::env::set_var("GOAT2_HOST_TOKEN", "ui-secret");
        std::env::set_var("GOAT_THREAD_ID", "t1");
    }
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let logs = |driver: &str| dir.path().join(format!("{driver}.log"));
    let grok = stand_in(&bin, "grok", &logs("grok"));
    let fx = stand_in(&bin, "fx", &logs("fx"));
    let agy = stand_in(&bin, "agy", &logs("antigravity"));
    let data = dir.path().join("data");
    let factories = acp_factories(&data, Some(&grok), Some(&fx), Some(&agy));
    assert_eq!(factories.len(), 3);
    for (driver, factory) in factories {
        let started = factory.start(spec(dir.path())).await;
        assert!(started.is_err(), "{driver}: the stand-in never answers");
        // Grok and fx probes run their CLIs; Antigravity's resolves the runtime without it.
        let _ = factory.probe().await.unwrap();
        let log = std::fs::read_to_string(logs(&driver)).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert!(!lines.is_empty(), "{driver} was started");
        assert!(lines.iter().all(|l| *l == "absent"), "{driver}: {lines:?}");
        if driver != "antigravity" {
            assert!(lines.len() > 1, "{driver}: the probe ran the CLI too");
        }
    }
}

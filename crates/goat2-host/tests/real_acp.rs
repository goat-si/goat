//! Real ACP agents through the host's own factories (the ones GOAT 2 (Dev) registers): a probe,
//! then one plain turn. Ignored: they need the installed CLI signed in and make a real model call.
//! Run with: cargo test -p goat2-host --test real_acp -- --ignored --nocapture <name>
//! GOAT's stdio MCP bridge is taken from GOAT2_ACP_MCP_BRIDGE (build it with
//! cargo build -p goat2-acp-mcp-bridge) for agents that need it.

use std::time::Duration;

use goat2_contracts::{EngineConfig, ModelSelection, RuntimeMode};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineInput, McpEndpoint, SessionSpec, TurnOutcome, TurnSettings,
    TurnStartResult,
};
use goat2_host::engine::acp::{antigravity_factory, grok_factory};

const TURN_LIMIT: Duration = Duration::from_secs(240);

/// Probe, print what it found (no account details), and pick the default model.
async fn probe_model(factory: &dyn EngineFactory, driver: &str) -> Option<String> {
    let probe = factory.probe().await.expect("probe");
    let models: Vec<&str> = probe.models.iter().map(|m| m.slug.as_str()).collect();
    eprintln!(
        "{driver} probe: status {:?}, auth {:?}, installed {}, version {:?}, models {models:?}, message {:?}",
        probe.status, probe.auth.status, probe.installed, probe.version, probe.message
    );
    probe
        .models
        .iter()
        .find(|m| m.is_default == Some(true))
        .or_else(|| probe.models.first())
        .map(|m| m.slug.clone())
}

async fn one_turn(factory: &dyn EngineFactory, driver: &str, model: String) {
    let cwd = tempfile::tempdir().unwrap();
    let selection = ModelSelection {
        instance_id: driver.into(),
        model,
        options: None,
    };
    let spec = SessionSpec {
        thread_id: format!("real-{driver}").into(),
        engine: EngineConfig {
            provider_instance_id: driver.into(),
            model_selection: selection.clone(),
            runtime_mode: RuntimeMode::FullAccess,
            cwd: cwd.path().to_string_lossy().into_owned(),
        },
        resume: None,
        // Nothing listens here: the turn needs no GOAT tools.
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "smoke".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        instance: None,
    };
    let mut handle = factory.start(spec).await.expect("start");
    let settings = TurnSettings {
        model_selection: selection,
        runtime_mode: RuntimeMode::FullAccess,
    };
    let started = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: "smoke-1".into(),
                text: "Reply with exactly: GOAT2-ACP-OK".into(),
                attachments: vec![],
            }],
            &settings,
        )
        .await;
    assert!(
        matches!(started, TurnStartResult::Accepted { .. }),
        "{started:?}"
    );
    let mut text = String::new();
    let outcome = tokio::time::timeout(TURN_LIMIT, async {
        loop {
            match handle.events.recv().await.expect("event stream ended") {
                EngineEvent::TextDelta { text: delta, .. } => text.push_str(&delta),
                EngineEvent::TurnFinished { outcome, .. } => break outcome,
                EngineEvent::AuthRequired { message, .. } => panic!("sign-in required: {message}"),
                _ => {}
            }
        }
    })
    .await
    .expect("turn finished in time");
    eprintln!("{driver} turn: {outcome:?}, reply {text:?}");
    assert_eq!(outcome, TurnOutcome::Done);
    assert!(text.contains("GOAT2-ACP-OK"), "reply: {text}");
}

#[tokio::test]
#[ignore = "runs the installed grok CLI signed in; makes a real model call"]
async fn real_grok_turn_through_the_host_factory() {
    let data = tempfile::tempdir().unwrap();
    let factory = grok_factory(data.path(), None);
    let model = probe_model(&factory, "grok")
        .await
        .expect("grok lists a model");
    one_turn(&factory, "grok", model).await;
}

#[tokio::test]
#[ignore = "runs the installed Antigravity runtime signed in to GOAT 2's own profile; makes a real model call"]
async fn real_antigravity_turn_through_the_host_factory() {
    let data = std::env::var_os("GOAT2_REAL_ANTIGRAVITY_DATA_DIR")
        .map(std::path::PathBuf::from)
        .expect(
            "GOAT2_REAL_ANTIGRAVITY_DATA_DIR: a data dir whose Antigravity profile is signed in",
        );
    let factory = antigravity_factory(&data, None);
    // v1 finds the runtime without starting it, so the probe lists no models: "default" is the
    // account default.
    let model = probe_model(&factory, "antigravity")
        .await
        .unwrap_or_else(|| "default".to_owned());
    one_turn(&factory, "antigravity", model).await;
}

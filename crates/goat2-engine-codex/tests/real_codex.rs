//! Smoke test against the real installed codex (0.167.0), driven through [CodexEngineFactory] with
//! production defaults. Ignored by default: it signs in with the local Codex account and makes a
//! few small model calls.
//!
//! cargo test -p goat2-engine-codex --test real_codex -- --ignored --nocapture
//! (GOAT2_SMOKE_MODEL overrides the model, default gpt-6-luna.)

use std::time::Duration;

use goat2_contracts::{
    EngineConfig, InputId, ModelSelection, ProviderInstanceId, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, McpEndpoint, SessionSpec, SteerResult,
    TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_codex::{CodexEngineFactory, CodexEngineOptions};
use serde_json::json;

const WAIT: Duration = Duration::from_secs(180);

fn model() -> String {
    std::env::var("GOAT2_SMOKE_MODEL").unwrap_or_else(|_| "gpt-6-luna".into())
}

fn selection() -> ModelSelection {
    serde_json::from_value(json!({
        "instanceId": "codex",
        "model": model(),
        "options": [{"id": "reasoningEffort", "value": "low"}]
    }))
    .expect("model selection")
}

fn spec(cwd: &std::path::Path, resume: Option<goat2_contracts::EngineRef>) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::new("goat-smoke-thread"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("codex"),
            model_selection: selection(),
            runtime_mode: RuntimeMode::AutoAcceptEdits,
            cwd: cwd.to_string_lossy().into_owned(),
        },
        resume,
        // Nothing listens here; Codex reports the GOAT MCP server as failed, the turn still runs.
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "smoketoken0123456789".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: None,
    }
}

fn settings() -> TurnSettings {
    TurnSettings {
        model_selection: selection(),
        runtime_mode: RuntimeMode::AutoAcceptEdits,
    }
}

fn input(id: &str, text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::new(id),
        text: text.into(),
        attachments: Vec::new(),
    }]
}

async fn turn(h: &EngineHandle, id: &str, text: &str) -> String {
    match h.session.start_turn(input(id, text), &settings()).await {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}

/// Collect events until the turn finishes. Requests are unexpected in auto-accept-edits mode.
async fn until_finished(h: &mut EngineHandle) -> Vec<EngineEvent> {
    let deadline = tokio::time::Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout_at(deadline, h.events.recv())
            .await
            .expect("turn finished in time")
            .expect("event stream open");
        match &event {
            EngineEvent::Exited { reason } => panic!("codex exited: {reason}"),
            EngineEvent::RequestOpened { summary, .. } => panic!("unexpected request: {summary}"),
            _ => {}
        }
        let done = matches!(event, EngineEvent::TurnFinished { .. });
        events.push(event);
        if done {
            return events;
        }
    }
}

fn answer(events: &[EngineEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage { text, .. } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn outcome(events: &[EngineEvent]) -> TurnOutcome {
    match events.last() {
        Some(EngineEvent::TurnFinished { outcome, .. }) => outcome.clone(),
        other => panic!("no turn end: {other:?}"),
    }
}

#[cfg(unix)]
fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only checks that the group exists.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

#[cfg(unix)]
fn nice_of(pid: i32) -> i32 {
    let out = std::process::Command::new("ps")
        .args(["-o", "nice=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("nice value")
}

#[tokio::test]
#[ignore = "runs the real installed codex with the local account"]
async fn real_codex_smoke() {
    let cwd = std::env::temp_dir().join(format!("goat2-codex-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("cwd");
    let factory = CodexEngineFactory::new(CodexEngineOptions::default());

    // Start, one plain turn.
    let mut h = factory.start(spec(&cwd, None)).await.expect("start codex");
    let pgid = h.session.process_group_id();
    #[cfg(unix)]
    {
        let pgid = pgid.expect("process group id");
        assert!(group_alive(pgid));
        assert_eq!(nice_of(pgid), 10, "codex app-server runs under nice 10");
        assert!(h.session.group_rss_bytes().is_some_and(|rss| rss > 0));
    }
    let t1 = turn(&h, "smoke-1", "Reply with exactly: GOAT2-OK").await;
    let events = until_finished(&mut h).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EngineEvent::TextDelta { .. })),
        "text streamed live"
    );
    assert!(
        answer(&events).contains("GOAT2-OK"),
        "answer: {}",
        answer(&events)
    );
    assert_eq!(outcome(&events), TurnOutcome::Done);
    eprintln!(
        "smoke: turn {t1} done, pgid {pgid:?}, rss {:?}",
        h.session.group_rss_bytes()
    );

    // Steer a running turn.
    let t2 = turn(
        &h,
        "smoke-2",
        "Run the shell command `sleep 5` exactly once, then reply with exactly: DONE",
    )
    .await;
    let steered = h
        .session
        .steer(
            &t2,
            input("smoke-3", "After that, reply with exactly: DONE STEERED"),
        )
        .await;
    assert_eq!(steered, SteerResult::Accepted);
    let events = until_finished(&mut h).await;
    assert_eq!(outcome(&events), TurnOutcome::Done);
    assert!(
        answer(&events).contains("STEERED"),
        "answer: {}",
        answer(&events)
    );

    // Interrupt a running turn.
    let t3 = turn(
        &h,
        "smoke-4",
        "Run the shell command `sleep 30` exactly once, then reply with exactly: DONE",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(2000)).await;
    h.session.interrupt(&t3).await.expect("interrupt");
    let events = until_finished(&mut h).await;
    assert_eq!(outcome(&events), TurnOutcome::Interrupted);

    // Shutdown kills the whole group.
    let engine_ref = h.engine_ref.clone();
    h.session.shutdown().await;
    #[cfg(unix)]
    {
        let pgid = pgid.expect("process group id");
        for _ in 0..50 {
            if !group_alive(pgid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            !group_alive(pgid),
            "process group {pgid} gone after shutdown"
        );
    }

    // Resume the thread on a fresh process.
    let mut h = factory
        .start(spec(&cwd, Some(engine_ref.clone())))
        .await
        .expect("resume codex");
    assert_eq!(h.engine_ref.id, engine_ref.id, "same Codex thread");
    turn(&h, "smoke-5", "Reply with exactly: RESUMED").await;
    let events = until_finished(&mut h).await;
    assert!(
        answer(&events).contains("RESUMED"),
        "answer: {}",
        answer(&events)
    );
    h.session.shutdown().await;
    let _ = std::fs::remove_dir_all(&cwd);
}

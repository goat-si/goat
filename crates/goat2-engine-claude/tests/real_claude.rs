//! One turn against the real `claude` CLI. Ignored by default: it needs a signed-in Claude home and
//! makes one small paid model call. Run with
//! `GOAT2_REAL_CLAUDE=1 [CLAUDE_CONFIG_DIR=<home>] cargo test -p goat2-engine-claude --test real_claude -- --ignored`.

mod support;

use goat2_contracts::{AssistantMessagePhase, RuntimeMode, TurnItemBody};
use goat2_engine_api::{EngineEvent, EngineFactory, EngineInput, TurnOutcome, TurnStartResult};
use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};
use support::*;

#[tokio::test]
#[ignore = "needs a signed-in claude CLI and makes a paid model call"]
async fn real_claude_answers_one_turn() {
    if std::env::var_os("GOAT2_REAL_CLAUDE").is_none() {
        return;
    }
    let run = Run::new("v1/simple.ndjson");
    let mut options = ClaudeEngineOptions::default();
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        options.launch.env.push(("CLAUDE_CONFIG_DIR".into(), dir));
    }
    let mut spec = run.spec("haiku", RuntimeMode::ApprovalRequired, None);
    spec.instance = None;
    // No GOAT MCP server is listening in this test.
    spec.mcp.url = String::new();
    let mut handle = ClaudeEngineFactory::new(options)
        .start(spec)
        .await
        .expect("start");
    let turn = handle
        .session
        .start_turn(
            vec![EngineInput {
                input_id: "i".into(),
                text: "Reply with exactly: goat2 claude ok".into(),
                attachments: Vec::new(),
            }],
            &settings("haiku", RuntimeMode::ApprovalRequired),
        )
        .await;
    assert!(matches!(turn, TurnStartResult::Accepted { .. }), "{turn:?}");
    let mut events = Vec::new();
    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(120), handle.events.recv())
            .await
            .expect("event")
            .expect("open");
        let done = matches!(event, EngineEvent::TurnFinished { .. });
        events.push(event);
        if done {
            break;
        }
    }
    let answer = events.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, .. } => match &item.body {
            TurnItemBody::AssistantMessage {
                phase: Some(AssistantMessagePhase::FinalAnswer),
                text,
                ..
            } => Some(text.clone()),
            _ => None,
        },
        _ => None,
    });
    assert!(
        matches!(
            events.last(),
            Some(EngineEvent::TurnFinished {
                outcome: TurnOutcome::Done,
                ..
            })
        ),
        "{events:?}"
    );
    assert!(answer.unwrap_or_default().contains("goat2 claude ok"));
    handle.session.shutdown().await;
}

//! A failed stdin write, in its own test binary: a child that a parallel test forks before it
//! execs inherits a copy of every pipe end open at that moment, which could keep this fake's
//! closed stdin readable and let the write the test relies on succeed. One test per process
//! rules that out.

mod support;

use goat2_contracts::RuntimeMode;
use goat2_engine_api::{EngineEvent, EngineInput, TurnStartResult};
use support::*;

const MODEL: &str = "claude-sonnet-5-5";

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: goat2_contracts::InputId::from("input-1"),
        text: text.to_string(),
        attachments: Vec::new(),
    }]
}

/// Review finding 3: a frame Claude never read is not reported as delivered, and the broken
/// session ends.
#[tokio::test]
async fn a_failed_stdin_write_is_not_reported_as_delivered() {
    let run = Run::new("wire/stdin_closed.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let started = handle
        .session
        .start_turn(input("Hello."), &settings(MODEL, RuntimeMode::FullAccess))
        .await;
    assert!(
        matches!(
            started,
            TurnStartResult::Unknown { .. } | TurnStartResult::Declined { .. }
        ),
        "{started:?}"
    );
    match next(&mut handle).await {
        EngineEvent::Exited { .. } => {}
        other => panic!("expected Exited, got {other:?}"),
    }
    handle.session.shutdown().await;
}

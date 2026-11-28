//! The driver against GOAT v1's own Claude replay transcripts (copied verbatim from
//! goat origin/dev 916b5ccc `apps/server/src/orchestration-v2/testkit/fixtures/*/claude_transcript.ndjson`),
//! replayed at the wire level by `goat2-fake-claude`.

mod support;

use goat2_contracts::{
    AssistantMessagePhase, EngineDriver, ProviderRequestKind, RequestKind, RequestOutcome,
    RuntimeMode, TurnItemBody, TurnItemStatus,
};
use goat2_engine_api::{
    EngineEvent, EngineHandle, EngineInput, RequestAnswer, SteerResult, TurnOutcome,
    TurnStartResult,
};
use support::*;

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: goat2_contracts::InputId::from("input-1"),
        text: text.to_string(),
        attachments: Vec::new(),
    }]
}

fn final_answers(events: &[EngineEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage {
                    phase: Some(AssistantMessagePhase::FinalAnswer),
                    text,
                    ..
                } => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn outcome(events: &[EngineEvent]) -> TurnOutcome {
    match events.last() {
        Some(EngineEvent::TurnFinished { outcome, .. }) => outcome.clone(),
        other => panic!("last event is not TurnFinished: {other:?}"),
    }
}

fn prompts(run: &Run) -> Vec<String> {
    let text = std::fs::read_to_string(&run.script).unwrap();
    let start: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    serde_json::from_value(start["metadata"]["prompts"].clone()).unwrap()
}

fn recorded_session(run: &Run) -> String {
    let text = std::fs::read_to_string(&run.script).unwrap();
    let start: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    start["metadata"]["nativeSessionId"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn start_turn(handle: &EngineHandle, text: &str, mode: RuntimeMode) -> String {
    match handle
        .session
        .start_turn(input(text), &settings("claude-sonnet-4-6", mode))
        .await
    {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}

fn answer(outcome: RequestOutcome) -> RequestAnswer {
    RequestAnswer {
        outcome,
        text: None,
        answers: None,
    }
}

#[tokio::test]
async fn simple_turn_boots_attaches_mcp_and_answers() {
    let run = Run::new("v1/simple.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    assert_eq!(handle.engine_ref.driver, EngineDriver::ClaudeAgent);
    let turn = start_turn(&handle, &prompts(&run)[0], RuntimeMode::FullAccess).await;
    assert!(turn.starts_with("turn:"), "synthetic turn id: {turn}");
    let events = until_finished(&mut handle).await;
    assert_eq!(outcome(&events), TurnOutcome::Done);
    assert_eq!(
        final_answers(&events),
        vec!["fixture simple ok".to_string()]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);

    let start = &run.starts()[0];
    let args: Vec<String> = serde_json::from_value(start["args"].clone()).unwrap();
    for word in [
        "--output-format",
        "stream-json",
        "--input-format",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--allow-dangerously-skip-permissions",
        "mcp__goat__*",
    ] {
        assert!(
            args.iter().any(|a| a == word),
            "argv lacks {word}: {args:?}"
        );
    }
    assert!(
        args.iter()
            .any(|a| a == &format!("--session-id={}", handle.engine_ref.id)),
        "the engine ref is the launched session id"
    );
    assert!(
        !args.iter().any(|a| a.contains(MCP_TOKEN)),
        "the MCP credential never reaches argv"
    );
    assert_eq!(start["env"]["CLAUDE_CODE_ENTRYPOINT"], "t3-code");
    assert_eq!(
        start["env"]["GOAT2_FAKE_CLAUDE_MARKER"], "1",
        "LaunchSpec env applied"
    );
    assert!(
        start["env"].get("GOAT_THREAD_ID").is_none(),
        "host identity removed"
    );
    assert!(start["env"].get("CLAUDECODE").is_none());
    assert!(
        !start["env"].to_string().contains(MCP_TOKEN),
        "the MCP credential never reaches the environment"
    );

    let stdin = run.stdin_frames();
    assert_eq!(stdin[0]["request"]["subtype"], "initialize");
    assert_eq!(stdin[0]["request"]["appendSystemPrompt"], "GOAT bot brief");
    assert_eq!(stdin[1]["request"]["subtype"], "mcp_set_servers");
    let goat = &stdin[1]["request"]["servers"]["goat"];
    assert_eq!(goat["type"], "http");
    assert_eq!(goat["url"], "http://127.0.0.1:4555/mcp");
    assert_eq!(
        goat["headers"]["Authorization"],
        format!("Bearer {MCP_TOKEN}")
    );
    assert_eq!(goat["timeout"], 65 * 60 * 1000);
}

#[tokio::test]
async fn two_turns_in_one_process() {
    let run = Run::new("v1/multi_turn.ndjson");
    let prompts = prompts(&run);
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    start_turn(&handle, &prompts[0], RuntimeMode::FullAccess).await;
    let first = until_finished(&mut handle).await;
    assert_eq!(
        final_answers(&first),
        vec!["first fixture turn complete".to_string()]
    );
    start_turn(&handle, &prompts[1], RuntimeMode::FullAccess).await;
    let second = until_finished(&mut handle).await;
    assert_eq!(
        final_answers(&second),
        vec!["second fixture turn complete".to_string()]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn a_turn_while_one_runs_is_declined() {
    let run = Run::new("v1/queued_turn.ndjson");
    let prompts = prompts(&run);
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    start_turn(&handle, &prompts[0], RuntimeMode::FullAccess).await;
    let declined = handle
        .session
        .start_turn(
            input("too early"),
            &settings("claude-sonnet-4-6", RuntimeMode::FullAccess),
        )
        .await;
    assert!(
        matches!(declined, TurnStartResult::Declined { .. }),
        "{declined:?}"
    );
    until_finished(&mut handle).await;
    start_turn(&handle, &prompts[1], RuntimeMode::FullAccess).await;
    assert_eq!(
        outcome(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn resume_reopens_the_same_session() {
    for fixture in [
        "v1/multi_turn_restart.ndjson",
        "v1/claude_idle_resume.ndjson",
    ] {
        let run = Run::new(fixture);
        let prompts = prompts(&run);
        let recorded = recorded_session(&run);
        let mut handle = run
            .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
            .await;
        assert_ne!(
            handle.engine_ref.id, recorded,
            "a new session gets its own id"
        );
        start_turn(&handle, &prompts[0], RuntimeMode::FullAccess).await;
        assert_eq!(
            outcome(&until_finished(&mut handle).await),
            TurnOutcome::Done
        );
        handle.session.shutdown().await;

        let mut resumed = run
            .start(
                "claude-sonnet-4-6",
                RuntimeMode::FullAccess,
                Some(&recorded),
            )
            .await;
        assert_eq!(resumed.engine_ref.id, recorded);
        start_turn(&resumed, &prompts[1], RuntimeMode::FullAccess).await;
        let events = until_finished(&mut resumed).await;
        assert_eq!(outcome(&events), TurnOutcome::Done);
        assert_eq!(
            final_answers(&events),
            vec![
                prompts[1]
                    .trim_start_matches("Respond with exactly: ")
                    .to_string()
            ]
        );
        resumed.session.shutdown().await;
        run.assert_replayed(2);
        let starts = run.starts();
        let args: Vec<String> = serde_json::from_value(starts[1]["args"].clone()).unwrap();
        assert!(args.contains(&format!("--resume={recorded}")), "{args:?}");
        assert!(!args.iter().any(|a| a.starts_with("--session-id=")));
        assert_eq!(starts[1]["env"]["MCP_CONNECTION_NONBLOCKING"], "0");
    }
}

#[tokio::test]
async fn approval_accept_runs_the_command() {
    let run = Run::new("v1/tool_call_restricted_granular.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::ApprovalRequired, None)
        .await;
    let turn = start_turn(&handle, &prompts(&run)[0], RuntimeMode::ApprovalRequired).await;
    let events = until(&mut handle, |e| {
        matches!(e, EngineEvent::RequestOpened { .. })
    })
    .await;
    let Some(EngineEvent::RequestOpened {
        turn_id,
        key,
        kind,
        summary,
        item,
        ..
    }) = events.last().cloned()
    else {
        unreachable!()
    };
    assert_eq!(turn_id, turn);
    assert_eq!(kind, RequestKind::Approval);
    assert!(
        summary.starts_with("printf"),
        "the command is the prompt: {summary}"
    );
    let item = item.expect("waiting item");
    assert_eq!(item.status, TurnItemStatus::Waiting);
    match &item.body {
        TurnItemBody::ApprovalRequest {
            request_kind,
            prompt,
            ..
        } => {
            assert_eq!(*request_kind, ProviderRequestKind::Command);
            assert_eq!(prompt.as_deref(), Some(summary.as_str()));
        }
        other => panic!("not an approval item: {other:?}"),
    }
    handle
        .session
        .answer_request(&key, answer(RequestOutcome::Accept))
        .await
        .unwrap();
    let rest = until_finished(&mut handle).await;
    assert_eq!(outcome(&rest), TurnOutcome::Done);
    let command = rest.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, .. } => match &item.body {
            TurnItemBody::CommandExecution { input, .. } => Some((input.clone(), item.status)),
            _ => None,
        },
        _ => None,
    });
    let (command, status) = command.expect("command item");
    assert!(command.starts_with("printf"));
    assert_eq!(status, TurnItemStatus::Completed);
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn approval_decline_denies_with_v1_text() {
    let run = Run::new("v1/tool_call_denied_write.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::ApprovalRequired, None)
        .await;
    start_turn(&handle, &prompts(&run)[0], RuntimeMode::ApprovalRequired).await;
    let events = until(&mut handle, |e| {
        matches!(e, EngineEvent::RequestOpened { .. })
    })
    .await;
    let Some(EngineEvent::RequestOpened { key, item, .. }) = events.last().cloned() else {
        unreachable!()
    };
    match &item.unwrap().body {
        TurnItemBody::ApprovalRequest { request_kind, .. } => {
            assert_eq!(*request_kind, ProviderRequestKind::FileChange)
        }
        other => panic!("{other:?}"),
    }
    handle
        .session
        .answer_request(&key, answer(RequestOutcome::Decline))
        .await
        .unwrap();
    let rest = until_finished(&mut handle).await;
    assert_eq!(outcome(&rest), TurnOutcome::Done);
    assert_eq!(
        final_answers(&rest),
        vec!["write permission denied".to_string()]
    );
    let streamed: String = rest
        .iter()
        .filter_map(|e| match e {
            EngineEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        streamed, "write permission denied",
        "partial frames stream as text deltas"
    );
    let reasoning = events.iter().any(|e| {
        matches!(e, EngineEvent::ItemCompleted { item, .. } if matches!(item.body, TurnItemBody::Reasoning { .. }))
    });
    assert!(!reasoning, "empty thinking blocks are not items");
    let write = rest.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, .. }
            if matches!(item.body, TurnItemBody::FileChange { .. }) =>
        {
            Some(item.status)
        }
        _ => None,
    });
    assert_eq!(write, Some(TurnItemStatus::Failed));
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn subagents_report_progress_and_results() {
    let run = Run::new("v1/subagent.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    start_turn(&handle, &prompts(&run)[0], RuntimeMode::FullAccess).await;
    let events = until_finished(&mut handle).await;
    assert_eq!(outcome(&events), TurnOutcome::Done);
    let running = events.iter().any(|e| {
        matches!(
            e,
            EngineEvent::SubagentUpdate {
                status: TurnItemStatus::Running,
                ..
            }
        )
    });
    assert!(running, "task_started/progress become SubagentUpdate");
    let subagents: Vec<(String, Option<String>)> = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::Subagent {
                    subagent_id,
                    result,
                    ..
                } => Some((subagent_id.clone(), result.clone())),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(subagents.len(), 2, "{subagents:?}");
    assert!(subagents.iter().all(|(id, result)| id.starts_with("toolu_")
        && result.as_deref().is_some_and(|r| r.contains("contents"))));
    // The subagents' own tool calls are not root items.
    let reads = events
        .iter()
        .filter(|e| {
            matches!(e, EngineEvent::ItemCompleted { item, .. }
                if matches!(&item.body, TurnItemBody::DynamicTool { tool_name: Some(n), .. } if n == "Read"))
        })
        .count();
    assert_eq!(reads, 0);
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// v1's 2.1.111 steering recording: that CLI sends no `command_lifecycle`, so (owner decision
/// 2026-11-29, a deliberate difference from v1) the steer is Declined and never written; the host
/// queues it as the next turn's followup. The recording, which expects the steer, cannot finish.
#[tokio::test]
async fn steer_on_a_cli_without_lifecycle_is_declined() {
    let run = Run::new("v1/message_steering.ndjson");
    let prompts = prompts(&run);
    let handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    let turn = start_turn(&handle, &prompts[0], RuntimeMode::FullAccess).await;
    let steer = handle.session.steer(&turn, input(&prompts[1])).await;
    assert!(matches!(steer, SteerResult::Declined { .. }), "{steer:?}");
    handle.session.shutdown().await;
    assert!(
        !run.stdin_frames().iter().any(|f| f["priority"] == "next"),
        "the declined steer reached Claude"
    );
}

#[tokio::test]
async fn steer_into_an_ended_turn_is_declined() {
    let run = Run::new("v1/simple.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    let turn = start_turn(&handle, &prompts(&run)[0], RuntimeMode::FullAccess).await;
    until_finished(&mut handle).await;
    let steer = handle.session.steer(&turn, input("late")).await;
    assert!(matches!(steer, SteerResult::Declined { .. }), "{steer:?}");
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn interrupt_settles_the_turn_as_interrupted() {
    let run = Run::new("v1/turn_interrupt.ndjson");
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    let turn = start_turn(&handle, &prompts(&run)[0], RuntimeMode::FullAccess).await;
    handle.session.interrupt(&turn).await.unwrap();
    let events = until_finished(&mut handle).await;
    assert_eq!(outcome(&events), TurnOutcome::Interrupted);
    // Interrupting a turn that already ended is a no-op.
    handle.session.interrupt(&turn).await.unwrap();
    handle.session.shutdown().await;
    run.assert_stopped_after_interrupt();
}

#[tokio::test]
async fn sign_in_failure_asks_for_login_then_recovers() {
    let run = Run::new("v1/claude_result_is_error.ndjson");
    let prompts = prompts(&run);
    let mut handle = run
        .start("claude-sonnet-4-6", RuntimeMode::FullAccess, None)
        .await;
    let turn = start_turn(&handle, &prompts[0], RuntimeMode::FullAccess).await;
    let events = until_finished(&mut handle).await;
    let auth = events.iter().find_map(|e| match e {
        // Claude's sign-in is not answered through the engine: no key.
        EngineEvent::AuthRequired {
            key: None,
            turn_id,
            url,
            message,
        } => Some((turn_id.clone(), url.clone(), message.clone())),
        _ => None,
    });
    let (auth_turn, url, message) = auth.expect("AuthRequired");
    assert_eq!(auth_turn.as_deref(), Some(turn.as_str()));
    assert_eq!(url, None);
    assert!(
        message.starts_with("Claude could not authenticate."),
        "{message}"
    );
    assert!(matches!(outcome(&events), TurnOutcome::Failed { .. }));
    assert!(
        final_answers(&events).is_empty(),
        "the CLI's synthetic error text is not an answer"
    );
    start_turn(&handle, &prompts[1], RuntimeMode::FullAccess).await;
    let second = until_finished(&mut handle).await;
    assert_eq!(outcome(&second), TurnOutcome::Done);
    assert_eq!(
        final_answers(&second),
        vec!["claude result is_error fixture recovered".to_string()]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

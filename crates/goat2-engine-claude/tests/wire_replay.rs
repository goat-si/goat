//! Claude 2.1.332 wire behaviour v1's SDK-level transcripts do not carry: AskUserQuestion,
//! ExitPlanMode, `command_lifecycle` steering, model and mode changes, a withdrawn approval, and a
//! real logged-out capture.

mod support;

use goat2_contracts::{
    AssistantMessagePhase, RequestKind, RequestOutcome, RuntimeMode, TurnItemBody, TurnItemStatus,
};
use goat2_engine_api::{
    EngineEvent, EngineHandle, EngineInput, RequestAnswer, SteerResult, TurnOutcome,
    TurnStartResult,
};
use serde_json::{Map, json};
use support::*;

const MODEL: &str = "claude-sonnet-5-5";

fn input(text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: goat2_contracts::InputId::from("input-1"),
        text: text.to_string(),
        attachments: Vec::new(),
    }]
}

async fn turn(handle: &EngineHandle, text: &str, model: &str, mode: RuntimeMode) -> String {
    match handle
        .session
        .start_turn(input(text), &settings(model, mode))
        .await
    {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("turn not accepted: {other:?}"),
    }
}

fn answers(events: &[EngineEvent], phase: AssistantMessagePhase) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            EngineEvent::ItemCompleted { item, .. } => match &item.body {
                TurnItemBody::AssistantMessage {
                    phase: Some(p),
                    text,
                    ..
                } if *p == phase => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn finished(events: &[EngineEvent]) -> TurnOutcome {
    match events.last() {
        Some(EngineEvent::TurnFinished { outcome, .. }) => outcome.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn ask_user_question_is_a_question_request() {
    let run = Run::new("wire/ask_user_question.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    let turn_id = turn(
        &handle,
        "Ask me which color.",
        MODEL,
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let events = until(&mut handle, |e| {
        matches!(e, EngineEvent::RequestOpened { .. })
    })
    .await;
    let Some(EngineEvent::RequestOpened {
        turn_id: opened_turn,
        key,
        kind,
        item_id,
        item,
        summary,
    }) = events.last().cloned()
    else {
        unreachable!()
    };
    assert_eq!(opened_turn, turn_id);
    assert_eq!(kind, RequestKind::Question);
    assert_eq!(summary, "Which color?");
    assert_eq!(item_id.unwrap().as_str(), "toolu_ask1");
    let item = item.unwrap();
    assert_eq!(item.status, TurnItemStatus::Waiting);
    let TurnItemBody::UserInputRequest {
        questions,
        request_id,
    } = &item.body
    else {
        panic!("{:?}", item.body)
    };
    assert_eq!(request_id.as_str(), "toolu_ask1");
    assert_eq!(questions.len(), 1);
    assert_eq!(questions[0].id, "Which color?");
    assert_eq!(questions[0].header, "Color");
    assert_eq!(questions[0].options[0].label, "Red");
    assert_eq!(questions[0].options[0].description, "Warm");
    assert_eq!(questions[0].multi_select, Some(false));
    let mut picked = Map::new();
    picked.insert("Which color?".into(), json!(["Red"]));
    handle
        .session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Answered,
                text: None,
                answers: Some(picked),
            },
        )
        .await
        .unwrap();
    let rest = until_finished(&mut handle).await;
    assert_eq!(finished(&rest), TurnOutcome::Done);
    assert_eq!(
        answers(&rest, AssistantMessagePhase::FinalAnswer),
        vec!["You picked Red."]
    );
    // Answering again: the request is gone.
    assert!(
        handle
            .session
            .answer_request(
                &key,
                RequestAnswer {
                    outcome: RequestOutcome::Cancel,
                    text: None,
                    answers: None
                }
            )
            .await
            .is_err()
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn exit_plan_mode_records_the_plan_and_stops() {
    let run = Run::new("wire/exit_plan_mode.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    turn(
        &handle,
        "Plan the fix.",
        MODEL,
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let plan = events.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, .. } => match &item.body {
            TurnItemBody::ProposedPlan { markdown, .. } => Some(markdown.clone()),
            _ => None,
        },
        _ => None,
    });
    assert_eq!(plan.as_deref(), Some("1. Read the code\n2. Fix the test"));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestOpened { .. })),
        "the plan is not a request"
    );
    assert_eq!(
        answers(&events, AssistantMessagePhase::Commentary),
        vec!["Here is my plan."]
    );
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["Waiting for your go-ahead."]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn steer_acknowledged_by_lifecycle_continues_past_claudes_result() {
    let run = Run::new("wire/lifecycle_steer.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    // Wait until Claude is running the turn, as a person would steer mid-turn.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let steer = handle
        .session
        .steer(&turn_id, input("Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let ends = events
        .iter()
        .filter(|e| matches!(e, EngineEvent::TurnFinished { .. }))
        .count();
    assert_eq!(ends, 1, "one GOAT turn across both Claude results");
    assert_eq!(
        answers(&events, AssistantMessagePhase::Commentary),
        vec!["1, 2, 3."]
    );
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["1, 2, 3. done"]
    );
    let stdin = run.stdin_frames();
    let steer_frame = stdin
        .iter()
        .find(|f| f["type"] == "user" && f["priority"] == "next")
        .expect("steer frame");
    assert_eq!(steer_frame["message"]["content"], "Also say done.");
    assert!(steer_frame["uuid"].is_string());
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn steer_refused_by_claude_is_declined() {
    let run = Run::new("wire/lifecycle_steer_refused.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let steer = handle.session.steer(&turn_id, input("Too late.")).await;
    assert!(matches!(steer, SteerResult::Declined { .. }), "{steer:?}");
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn model_change_uses_set_model_and_mode_change_reopens() {
    let run = Run::new("wire/settings_change.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    let session = handle.engine_ref.id.clone();
    turn(&handle, "one", MODEL, RuntimeMode::ApprovalRequired).await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    turn(
        &handle,
        "two",
        "claude-opus-5-5",
        RuntimeMode::ApprovalRequired,
    )
    .await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    turn(
        &handle,
        "three",
        "claude-opus-5-5",
        RuntimeMode::AutoAcceptEdits,
    )
    .await;
    let third = until_finished(&mut handle).await;
    assert_eq!(finished(&third), TurnOutcome::Done);
    assert_eq!(
        answers(&third, AssistantMessagePhase::FinalAnswer),
        vec!["three"]
    );
    assert!(
        !third
            .iter()
            .any(|e| matches!(e, EngineEvent::Exited { .. })),
        "a reopen is not an exit"
    );
    handle.session.shutdown().await;
    run.assert_replayed(2);
    let starts = run.starts();
    let args: Vec<String> = serde_json::from_value(starts[1]["args"].clone()).unwrap();
    assert!(args.contains(&format!("--resume={session}")));
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--permission-mode" && w[1] == "acceptEdits")
    );
}

#[tokio::test]
async fn interrupt_withdraws_a_pending_approval() {
    let run = Run::new("wire/interrupt_pending_approval.ndjson");
    let mut factory = run.factory();
    // The CLI's own aborted result settles the turn; the fallback deadline is not needed.
    factory.options.interrupt_settle_timeout = std::time::Duration::from_secs(30);
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::ApprovalRequired, None),
    )
    .await
    .unwrap();
    let turn_id = turn(
        &handle,
        "Run the tests.",
        MODEL,
        RuntimeMode::ApprovalRequired,
    )
    .await;
    let opened = until(&mut handle, |e| {
        matches!(e, EngineEvent::RequestOpened { .. })
    })
    .await;
    let Some(EngineEvent::RequestOpened { key, item, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    match &item.unwrap().body {
        TurnItemBody::ApprovalRequest { prompt, reason, .. } => {
            assert_eq!(prompt.as_deref(), Some("npm test"));
            assert_eq!(reason.as_deref(), Some("Bash(npm test) requires approval"));
        }
        other => panic!("{other:?}"),
    }
    handle.session.interrupt(&turn_id).await.unwrap();
    let events = until_finished(&mut handle).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, EngineEvent::RequestClosed { key: k } if *k == key)),
        "the withdrawn approval closes"
    );
    assert_eq!(finished(&events), TurnOutcome::Interrupted);
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn real_logged_out_capture_asks_for_sign_in() {
    let run = Run::new("wire/auth_failure_2_1_332.ndjson");
    let mut handle = run
        .start("haiku", RuntimeMode::ApprovalRequired, None)
        .await;
    let turn_id = match handle
        .session
        .start_turn(
            input("Say hi in three words."),
            &settings("haiku", RuntimeMode::ApprovalRequired),
        )
        .await
    {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("{other:?}"),
    };
    let events = until_finished(&mut handle).await;
    assert!(events.iter().any(|e| matches!(
        e,
        EngineEvent::AuthRequired { turn_id: Some(t), url: None, .. } if *t == turn_id
    )));
    let TurnOutcome::Failed { reason } = finished(&events) else {
        panic!("not failed")
    };
    assert!(reason.contains("claude auth login"), "{reason}");
    assert!(answers(&events, AssistantMessagePhase::FinalAnswer).is_empty());
    assert!(answers(&events, AssistantMessagePhase::Commentary).is_empty());
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

#[tokio::test]
async fn a_crash_fails_the_turn_and_exits() {
    let run = Run::new("wire/crash_mid_turn.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let events = until_finished(&mut handle).await;
    let TurnOutcome::Failed { reason } = finished(&events) else {
        panic!("not failed: {events:?}")
    };
    assert_eq!(reason, "Claude exited: Error: fatal: out of memory");
    assert_eq!(
        answers(&events, AssistantMessagePhase::Commentary),
        vec!["Starting."],
        "text seen before the crash is kept"
    );
    match next(&mut handle).await {
        EngineEvent::Exited { reason } => assert!(reason.contains("out of memory"), "{reason}"),
        other => panic!("{other:?}"),
    }
    let after = handle
        .session
        .start_turn(input("again"), &settings(MODEL, RuntimeMode::FullAccess))
        .await;
    assert!(
        matches!(after, TurnStartResult::Declined { .. }),
        "{after:?}"
    );
    handle.session.shutdown().await;
}

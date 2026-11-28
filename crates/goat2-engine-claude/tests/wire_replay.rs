//! Claude 2.1.332 wire behaviour v1's SDK-level transcripts do not carry: AskUserQuestion,
//! ExitPlanMode, `command_lifecycle` steering, model and mode changes, a withdrawn approval, and a
//! real logged-out capture.

mod support;

use goat2_contracts::{
    AssistantMessagePhase, RequestKind, RequestOutcome, RuntimeMode, TurnItemBody, TurnItemStatus,
};
use goat2_engine_api::{
    EngineEvent, EngineHandle, EngineInput, RequestAnswer, SteerResult, SteerStatus, TurnOutcome,
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
        steer_updates(&events),
        vec![(
            turn_id.clone(),
            vec!["input-1".to_string()],
            SteerStatus::Completed
        )],
        "the steer reports Completed once Claude started it"
    );
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
    run.assert_stopped_after_interrupt();
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

/// Review finding 1 (v1 `ClaudeAdapterV2.ts:9755-9818`, `ClaudeStopTeardown.ts`): an interrupt
/// closes the CLI, so frames the stopped CLI would still send can never reach a later turn.
#[tokio::test]
async fn interrupt_closes_claude_so_a_later_turn_never_sees_the_stopped_turn() {
    let run = Run::new("wire/interrupt_late_frames.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work slowly.", MODEL, RuntimeMode::FullAccess).await;
    handle.session.interrupt(&turn_id).await.unwrap();
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Interrupted);
    let after = handle
        .session
        .start_turn(input("Next."), &settings(MODEL, RuntimeMode::FullAccess))
        .await;
    assert!(
        !matches!(after, TurnStartResult::Accepted { .. }),
        "a turn started onto the stopped CLI: {after:?}"
    );
    match next(&mut handle).await {
        EngineEvent::Exited { .. } => {}
        other => panic!("expected Exited after the stop, got {other:?}"),
    }
    assert!(
        run.stdin_frames()
            .iter()
            .any(|f| f["request"]["subtype"] == "interrupt")
    );
    handle.session.shutdown().await;
}

/// Review finding 2: shutdown during a turn closes its requests and settles the turn before
/// `Exited`.
#[tokio::test]
async fn shutdown_settles_the_turn_and_its_requests_before_exited() {
    let run = Run::new("wire/interrupt_pending_approval.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
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
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    handle.session.shutdown().await;
    let mut rest = Vec::new();
    loop {
        let event = next(&mut handle).await;
        let exited = matches!(event, EngineEvent::Exited { .. });
        rest.push(event);
        if exited {
            break;
        }
    }
    let closed = rest
        .iter()
        .position(|e| matches!(e, EngineEvent::RequestClosed { key: k } if *k == key));
    let finished_at = rest
        .iter()
        .position(|e| matches!(e, EngineEvent::TurnFinished { turn_id: t, .. } if *t == turn_id));
    assert!(closed.is_some(), "approval not closed: {rest:?}");
    assert!(finished_at.is_some(), "turn not settled: {rest:?}");
    assert!(matches!(
        &rest[finished_at.unwrap()],
        EngineEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        }
    ));
    assert!(
        matches!(rest.last(), Some(EngineEvent::Exited { reason }) if reason == "shutdown"),
        "{rest:?}"
    );
}

/// Review finding 4: a steer sent before Claude's first `command_lifecycle` frame still learns
/// that Claude refused it, so the host can queue it as a followup.
#[tokio::test]
async fn an_early_steer_refused_by_claude_is_declined() {
    let run = Run::new("wire/lifecycle_steer_early_refused.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle.session.steer(&turn_id, input("Too early.")).await;
    assert!(matches!(steer, SteerResult::Declined { .. }), "{steer:?}");
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["1, 2, 3."]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review finding 5 (v1 `ClaudeAdapterV2.ts:2572-2574` keeps background subagents past root
/// settlement): a background subagent that finishes while the thread is idle completes on the
/// turn that started it.
#[tokio::test]
async fn an_idle_background_subagent_completes_on_its_own_turn() {
    let run = Run::new("wire/background_subagent_idle.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(
        &handle,
        "Research in the background.",
        MODEL,
        RuntimeMode::FullAccess,
    )
    .await;
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let later = until(&mut handle, |e| {
        matches!(e, EngineEvent::ItemCompleted { .. })
    })
    .await;
    let Some(EngineEvent::ItemCompleted {
        turn_id: item_turn,
        item,
        ..
    }) = later.last()
    else {
        unreachable!()
    };
    assert_eq!(*item_turn, turn_id);
    assert_eq!(item.status, TurnItemStatus::Completed);
    match &item.body {
        TurnItemBody::Subagent { subagent_id, .. } => assert_eq!(subagent_id, "toolu_agent1"),
        other => panic!("{other:?}"),
    }
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review finding 6: when Claude dies on its own, its process (group) is reaped before `Exited`.
#[cfg(unix)]
#[tokio::test]
async fn an_unexpected_exit_is_reaped_before_exited() {
    let run = Run::new("wire/crash_mid_turn.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let pgid = handle.session.process_group_id().expect("pgid");
    turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    until(&mut handle, |e| matches!(e, EngineEvent::Exited { .. })).await;
    // SAFETY: signal 0 only checks whether the group still exists.
    let rc = unsafe { libc::kill(-pgid, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error();
    assert!(
        rc == -1 && errno == Some(libc::ESRCH),
        "process group {pgid} still exists (rc {rc}, errno {errno:?})"
    );
    handle.session.shutdown().await;
}

/// Review round 2 finding 1: Claude's result settles the turn while the interrupt answer is still
/// on its way; no new turn may start on the process the interrupt is about to close.
#[tokio::test]
async fn no_turn_starts_while_an_interrupt_is_still_closing_claude() {
    let run = Run::new("wire/interrupt_reply_after_result.ndjson");
    let mut factory = run.factory();
    // The interrupt answer comes 800 ms after the result; the stop deadline must outlast it.
    factory.options.interrupt_settle_timeout = std::time::Duration::from_secs(5);
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::FullAccess, None),
    )
    .await
    .unwrap();
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let EngineHandle {
        session, events, ..
    } = &mut handle;
    let stop = session.interrupt(&turn_id);
    let next_turn = async {
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                .await
                .expect("event within 10 s")
                .expect("events open");
            if matches!(event, EngineEvent::TurnFinished { .. }) {
                break;
            }
        }
        session
            .start_turn(input("Next."), &settings(MODEL, RuntimeMode::FullAccess))
            .await
    };
    let (stopped, started) = tokio::join!(stop, next_turn);
    stopped.unwrap();
    assert!(
        !matches!(started, TurnStartResult::Accepted { .. }),
        "a turn started on the process the interrupt closed: {started:?}"
    );
    handle.session.shutdown().await;
}

/// Review round 2 finding 2: when Claude refuses the interrupt, the turn goes on and its own
/// result decides the outcome.
#[tokio::test]
async fn a_refused_interrupt_leaves_the_turn_running() {
    let run = Run::new("wire/interrupt_refused.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let refused = handle.session.interrupt(&turn_id).await;
    assert!(refused.is_err(), "{refused:?}");
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["All done."]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 3 finding 1: Claude's result arrives first and its refusal of the interrupt after
/// it; the refused interrupt does not turn the finished work into an interrupted turn.
#[tokio::test]
async fn a_result_before_a_refused_interrupt_still_completes_the_turn() {
    let run = Run::new("wire/interrupt_result_then_refused.ndjson");
    let mut factory = run.factory();
    factory.options.interrupt_settle_timeout = std::time::Duration::from_secs(5);
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::FullAccess, None),
    )
    .await
    .unwrap();
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let refused = handle.session.interrupt(&turn_id).await;
    assert!(refused.is_err(), "{refused:?}");
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["All done."]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 3 finding 2: a shutdown that lands while a runtime-mode change is reopening
/// Claude ends the session for good; the reopen does not start a new process.
#[tokio::test]
async fn shutdown_during_a_reopen_starts_no_new_process() {
    let run = Run::new("wire/shutdown_during_reopen.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    turn(&handle, "one", MODEL, RuntimeMode::ApprovalRequired).await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    let session = &handle.session;
    let full_access = settings(MODEL, RuntimeMode::FullAccess);
    let reopen = session.start_turn(input("two"), &full_access);
    let stop = async {
        // The old process takes 1.5 s to exit, so this lands while the reopen tears it down.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        session.shutdown().await;
    };
    let (started, ()) = tokio::join!(reopen, stop);
    assert!(
        !matches!(started, TurnStartResult::Accepted { .. }),
        "a turn started after shutdown: {started:?}"
    );
    assert_eq!(
        run.starts().len(),
        1,
        "a new Claude process started after shutdown"
    );
}

/// Review round 3 finding 3 (v1 `ClaudeAdapterV2.ts:5241-5249`: completed alone is not proof of
/// acceptance): a steer Claude reports completed without starting stays pending, so the turn goes
/// on to the steer's own result.
#[tokio::test]
async fn a_steer_completed_without_starting_is_not_consumed() {
    let run = Run::new("wire/lifecycle_steer_completed_unstarted.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input("Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["1, 2, 3. done"]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 4 finding 1: a result held for a queued steer, released when Claude discards the
/// steer, still waits for the pending interrupt answer; a refusal leaves a completed turn.
#[tokio::test]
async fn a_steer_held_result_waits_for_the_interrupt_answer() {
    let run = Run::new("wire/steer_held_result_interrupt_refused.ndjson");
    let mut factory = run.factory();
    factory.options.interrupt_settle_timeout = std::time::Duration::from_secs(5);
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::FullAccess, None),
    )
    .await
    .unwrap();
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input("Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    // The root result is held for the queued steer: its text goes out as commentary.
    until(&mut handle, |e| {
        matches!(e, EngineEvent::ItemCompleted { .. })
    })
    .await;
    let refused = handle.session.interrupt(&turn_id).await;
    assert!(refused.is_err(), "{refused:?}");
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

fn input_as(id: &str, text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: goat2_contracts::InputId::from(id),
        text: text.to_string(),
        attachments: Vec::new(),
    }]
}

fn steer_updates(events: &[EngineEvent]) -> Vec<(String, Vec<String>, SteerStatus)> {
    events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::SteerUpdated {
                turn_id,
                input_ids,
                status,
            } => Some((
                turn_id.clone(),
                input_ids.iter().map(|i| i.to_string()).collect(),
                status.clone(),
            )),
            _ => None,
        })
        .collect()
}

/// Owner decision 2026-11-29 (v1 `steer.updated`, ClaudeAdapterV2.ts:5223-5266): a steer Claude
/// queued (answered Accepted) and then discarded reports Cancelled with its own input ids, so the
/// host can requeue it.
#[tokio::test]
async fn a_queued_steer_claude_discards_is_reported_cancelled() {
    let run = Run::new("wire/steer_queued_then_discarded.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-input", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let updates = steer_updates(&events);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0].0, turn_id);
    assert_eq!(updates[0].1, vec!["steer-input".to_string()]);
    assert!(
        matches!(&updates[0].2, SteerStatus::Cancelled { reason } if reason.contains("discarded")),
        "{updates:?}"
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// An accepted steer still unread when Claude exits reports Cancelled before the turn settles.
#[tokio::test]
async fn an_accepted_steer_unread_at_exit_is_reported_cancelled() {
    let run = Run::new("wire/steer_unread_at_exit.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-input", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until(&mut handle, |e| matches!(e, EngineEvent::Exited { .. })).await;
    let updates = steer_updates(&events);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0].1, vec!["steer-input".to_string()]);
    assert!(matches!(updates[0].2, SteerStatus::Cancelled { .. }));
    let cancelled_at = events
        .iter()
        .position(|e| matches!(e, EngineEvent::SteerUpdated { .. }))
        .unwrap();
    let finished_at = events
        .iter()
        .position(|e| matches!(e, EngineEvent::TurnFinished { .. }))
        .expect("turn settled");
    assert!(cancelled_at < finished_at);
    handle.session.shutdown().await;
}

/// Review round 5 finding 1 (v1 `ClaudeAdapterV2.ts:5237-5256`: each steer is read on its own
/// `started` or echo): of two queued steers only the started one completes; the other, later
/// discarded, is cancelled and never reported read.
#[tokio::test]
async fn only_the_started_steer_of_two_is_reported_completed() {
    let run = Run::new("wire/two_steers_one_started.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let first = handle
        .session
        .steer(&turn_id, input_as("steer-a", "First steer."))
        .await;
    let second = handle
        .session
        .steer(&turn_id, input_as("steer-b", "Second steer."))
        .await;
    assert_eq!(
        (first, second),
        (SteerResult::Accepted, SteerResult::Accepted)
    );
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let updates: Vec<(Vec<String>, bool)> = steer_updates(&events)
        .into_iter()
        .map(|(_, ids, status)| (ids, status == SteerStatus::Completed))
        .collect();
    assert_eq!(
        updates,
        vec![
            (vec!["steer-a".to_string()], true),
            (vec!["steer-b".to_string()], false),
        ]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 5 finding 2: a steer Claude started is read for good; a later discard of it does
/// not cancel (and so requeue) it.
#[tokio::test]
async fn a_discard_after_start_does_not_cancel_a_read_steer() {
    let run = Run::new("wire/steer_started_then_discarded.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-a", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(
        steer_updates(&events),
        vec![(
            turn_id.clone(),
            vec!["steer-a".to_string()],
            SteerStatus::Completed
        )]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 5 finding 3: Claude starts the steer and finishes the turn before `steer`
/// returns; the steer's outcome still goes out before the turn ends.
#[tokio::test]
async fn a_steer_read_before_steer_returns_reports_before_the_turn_ends() {
    let run = Run::new("wire/steer_burst_finishes_turn.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-a", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    let completed_at = events.iter().position(|e| {
        matches!(
            e,
            EngineEvent::SteerUpdated {
                status: SteerStatus::Completed,
                ..
            }
        )
    });
    assert!(
        completed_at.is_some(),
        "no Completed before TurnFinished: {events:?}"
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 6 finding 1: Claude's stdout closes while its stderr stays open, and a
/// runtime-mode reopen replaces the process during the stderr wait; the old reader must not
/// settle the new session.
#[tokio::test]
async fn a_stale_eof_does_not_settle_the_reopened_session() {
    let run = Run::new("wire/stale_eof_across_reopen.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    turn(&handle, "one", MODEL, RuntimeMode::ApprovalRequired).await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    turn(&handle, "two", MODEL, RuntimeMode::FullAccess).await;
    let events = until_finished(&mut handle).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, EngineEvent::Exited { .. })),
        "the old process's exit settled the reopened session: {events:?}"
    );
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["two"]
    );
    handle.session.shutdown().await;
}

/// Review round 6 finding 2: on a CLI without `command_lifecycle`, a steer whose write is still
/// blocked when the turn ends, and then fails, is neither reported nor answered Accepted.
#[tokio::test]
async fn a_steer_whose_write_never_lands_is_not_accepted() {
    let run = Run::new("wire/steer_write_blocked_turn_ends.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    // system:init arrives first, so the driver knows this CLI sends no lifecycle frames.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    // Larger than a pipe buffer: the write blocks while the CLI is not reading.
    let big = "x".repeat(512 * 1024);
    let EngineHandle {
        session, events, ..
    } = &mut handle;
    let steer = session.steer(&turn_id, input_as("steer-big", &big));
    let collect = async {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                .await
                .expect("event within 10 s")
                .expect("events open");
            let exited = matches!(event, EngineEvent::Exited { .. });
            seen.push(event);
            if exited {
                return seen;
            }
        }
    };
    let (steered, seen) = tokio::join!(steer, collect);
    assert!(
        !matches!(steered, SteerResult::Accepted),
        "a steer that never reached Claude was accepted"
    );
    assert!(
        steer_updates(&seen).is_empty(),
        "an unwritten steer was reported: {:?}",
        steer_updates(&seen)
    );
    handle.session.shutdown().await;
}

/// Review round 6 finding 3: a lifecycle CLI queued the steer and finished the turn without
/// starting or echoing it; the steer was not read, so it is Cancelled (the host requeues it).
#[tokio::test]
async fn a_queued_steer_left_unstarted_by_a_successful_turn_is_cancelled() {
    let run = Run::new("wire/steer_queued_success_without_start.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-a", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    let updates = steer_updates(&events);
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert!(
        matches!(updates[0].2, SteerStatus::Cancelled { .. }),
        "{updates:?}"
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 7 finding 1: the steer's write is still blocked when the CLI's first frame shows
/// it has no `command_lifecycle`; the steer is accepted only once its write lands, so a write that
/// never lands is neither reported nor accepted.
#[tokio::test]
async fn a_steer_blocked_before_lifecycle_is_known_is_not_accepted_unwritten() {
    let run = Run::new("wire/steer_blocked_before_first_frame.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let big = "x".repeat(512 * 1024);
    let EngineHandle {
        session, events, ..
    } = &mut handle;
    let steer = session.steer(&turn_id, input_as("steer-big", &big));
    let collect = async {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                .await
                .expect("event within 10 s")
                .expect("events open");
            let exited = matches!(event, EngineEvent::Exited { .. });
            seen.push(event);
            if exited {
                return seen;
            }
        }
    };
    let (steered, seen) = tokio::join!(steer, collect);
    assert!(!matches!(steered, SteerResult::Accepted), "{steered:?}");
    assert!(
        steer_updates(&seen).is_empty(),
        "an unwritten steer was reported: {:?}",
        steer_updates(&seen)
    );
    handle.session.shutdown().await;
}

/// Review round 7 finding 2: a frame the old process sent is received, then held (frame hook)
/// while a runtime-mode reopen replaces the process; it must not land in the new session.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_old_frame_held_across_a_reopen_is_dropped() {
    let run = Run::new("wire/stale_frame_across_reopen.ndjson");
    let mut factory = run.factory();
    // The hook reports when it holds the old frame and keeps it until the reopen is done.
    let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let held_tx = std::sync::Mutex::new(held_tx);
    let go_rx = std::sync::Mutex::new(go_rx);
    factory.options.frame_hook = Some(std::sync::Arc::new(move |generation, line: &str| {
        if generation == 1 && line.contains("stale-marker") {
            let _ = held_tx.lock().unwrap().send(());
            let _ = go_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(10));
        }
    }));
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::ApprovalRequired, None),
    )
    .await
    .unwrap();
    turn(&handle, "one", MODEL, RuntimeMode::ApprovalRequired).await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    tokio::task::spawn_blocking(move || held_rx.recv_timeout(std::time::Duration::from_secs(10)))
        .await
        .unwrap()
        .expect("the old frame is held");
    turn(&handle, "two", MODEL, RuntimeMode::FullAccess).await;
    go_tx.send(()).unwrap();
    let events = until_finished(&mut handle).await;
    let texts: Vec<String> = [
        AssistantMessagePhase::Commentary,
        AssistantMessagePhase::FinalAnswer,
    ]
    .into_iter()
    .flat_map(|phase| answers(&events, phase))
    .collect();
    assert!(
        !texts.iter().any(|t| t.contains("stale-marker")),
        "an old process frame landed in the reopened session: {texts:?}"
    );
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["two"]
    );
    handle.session.shutdown().await;
}

/// Review round 8 finding 1 (v1 `ClaudeAdapterV2.ts:5237-5256`: a uuid echo is acceptance): the
/// result echoes the steer before any lifecycle frame for it; the steer is accepted and read.
#[tokio::test]
async fn a_steer_echoed_by_the_result_before_its_lifecycle_is_accepted() {
    let run = Run::new("wire/steer_echoed_before_lifecycle.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Count to three.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-a", "Also say done."))
        .await;
    assert_eq!(steer, SteerResult::Accepted);
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        steer_updates(&events),
        vec![(
            turn_id.clone(),
            vec!["steer-a".to_string()],
            SteerStatus::Completed
        )]
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 9 finding 1: on a lifecycle CLI the turn ends while the steer's write is blocked,
/// then the write lands. Claude may run it as its own prompt, so the answer is Unknown (never
/// Declined, which would requeue it), and no status is reported for it.
#[tokio::test]
async fn a_steer_written_after_its_turn_ended_is_unknown() {
    let run = Run::new("wire/steer_write_lands_after_turn.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    // command_lifecycle for the root prompt arrives first: the CLI reports lifecycles.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let big = "x".repeat(512 * 1024);
    let EngineHandle {
        session, events, ..
    } = &mut handle;
    let steer = session.steer(&turn_id, input_as("steer-big", &big));
    let collect = async {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                .await
                .expect("event within 10 s")
                .expect("events open");
            let done = matches!(event, EngineEvent::TurnFinished { .. });
            seen.push(event);
            if done {
                return seen;
            }
        }
    };
    let (steered, seen) = tokio::join!(steer, collect);
    assert!(
        matches!(steered, SteerResult::Unknown { .. }),
        "{steered:?}"
    );
    assert_eq!(finished(&seen), TurnOutcome::Done);
    assert!(
        steer_updates(&seen).is_empty(),
        "{:?}",
        steer_updates(&seen)
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Review round 10 finding 1: Claude reads the steer and crashes before acknowledging it. The exit
/// does not show it went unread, so the answer is Unknown (Declined would requeue it).
#[tokio::test]
async fn a_written_steer_without_a_verdict_at_exit_is_unknown() {
    let run = Run::new("wire/steer_read_then_crash.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let turn_id = turn(&handle, "Work.", MODEL, RuntimeMode::FullAccess).await;
    let steer = handle
        .session
        .steer(&turn_id, input_as("steer-a", "Also this."))
        .await;
    assert!(matches!(steer, SteerResult::Unknown { .. }), "{steer:?}");
    let events = until(&mut handle, |e| matches!(e, EngineEvent::Exited { .. })).await;
    assert!(
        steer_updates(&events).is_empty(),
        "{:?}",
        steer_updates(&events)
    );
    handle.session.shutdown().await;
}

/// Final review finding 1 (v1 `ClaudeAdapterV2.ts:8918-8926`,
/// `ClaudeBackgroundWorkBlocksQueryReplacementError`): a settings change that needs a new process
/// is refused while a background subagent runs, and the subagent goes on to finish.
#[tokio::test]
async fn a_reopen_is_refused_while_a_background_subagent_runs() {
    let run = Run::new("wire/background_subagent_blocks_reopen.ndjson");
    let mut handle = run.start(MODEL, RuntimeMode::ApprovalRequired, None).await;
    turn(
        &handle,
        "Research in the background.",
        MODEL,
        RuntimeMode::ApprovalRequired,
    )
    .await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    let reopen = handle
        .session
        .start_turn(input("Next."), &settings(MODEL, RuntimeMode::FullAccess))
        .await;
    match &reopen {
        TurnStartResult::Declined { reason } => {
            assert!(reason.contains("background agents"), "{reason}")
        }
        other => panic!("a reopen ran over a background subagent: {other:?}"),
    }
    let later = until(&mut handle, |e| {
        matches!(e, EngineEvent::ItemCompleted { .. })
    })
    .await;
    let Some(EngineEvent::ItemCompleted { item, .. }) = later.last() else {
        unreachable!()
    };
    assert_eq!(item.status, TurnItemStatus::Completed);
    assert_eq!(run.starts().len(), 1, "no new Claude process");
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Final review finding 2: Claude answers the turn before its write is acknowledged; the start
/// still answers Accepted with the turn the TurnFinished names.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_result_before_the_start_ack_still_accepts_the_turn() {
    let run = Run::new("wire/result_before_start_ack.ndjson");
    let mut factory = run.factory();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let go_rx = std::sync::Mutex::new(go_rx);
    factory.options.write_hook = Some(std::sync::Arc::new(move |line: &str| {
        if line.contains("Fast.") {
            let _ = go_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(10));
        }
    }));
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::FullAccess, None),
    )
    .await
    .unwrap();
    let EngineHandle {
        session, events, ..
    } = &mut handle;
    let full_access = settings(MODEL, RuntimeMode::FullAccess);
    let start = session.start_turn(input("Fast."), &full_access);
    let finished_turn = async {
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(10), events.recv())
                .await
                .expect("event within 10 s")
                .expect("events open");
            if let EngineEvent::TurnFinished { turn_id, .. } = event {
                go_tx.send(()).unwrap();
                return turn_id;
            }
        }
    };
    let (started, finished_id) = tokio::join!(start, finished_turn);
    assert_eq!(
        started,
        TurnStartResult::Accepted {
            turn_id: finished_id
        }
    );
    handle.session.shutdown().await;
    run.assert_replayed(1);
}

/// Final review finding 3: `set_config` cannot change effort, thinking or fast mode on a live
/// process, so it says so instead of reporting success.
#[tokio::test]
async fn set_config_refuses_option_changes_it_cannot_apply() {
    let run = Run::new("wire/result_before_start_ack.ndjson");
    let handle = run.start(MODEL, RuntimeMode::FullAccess, None).await;
    let mut changed = settings(MODEL, RuntimeMode::FullAccess);
    changed.model_selection.options = Some(vec![goat2_contracts::ProviderOptionSelection {
        id: "effort".into(),
        value: goat2_contracts::ProviderOptionSelectionValue::Text("high".into()),
    }]);
    let result = handle.session.set_config(&changed).await;
    assert!(
        matches!(result, Err(goat2_engine_api::EngineError::Unsupported(_))),
        "{result:?}"
    );
    handle.session.shutdown().await;
}

/// Final review 2 finding 1 (v1 `ClaudeAdapterV2.ts:7269-7315`, `:8749-8759`, `:8918-8926`;
/// `ClaudeBackgroundTasks.ts` local_bash roster): a background shell command blocks a reopen like
/// a background subagent, and once it finishes the reopen goes ahead.
#[tokio::test]
async fn a_background_command_blocks_a_reopen_until_it_finishes() {
    let run = Run::new("wire/background_command_blocks_reopen.ndjson");
    let mut factory = run.factory();
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    // The fake sends keep_alive right after the task_notification; once the hook sees it, the
    // notification has been applied.
    factory.options.frame_hook = Some(std::sync::Arc::new(move |_, line: &str| {
        if line.contains("keep_alive") {
            let _ = seen_tx.send(());
        }
    }));
    let mut handle = goat2_engine_api::EngineFactory::start(
        &factory,
        run.spec(MODEL, RuntimeMode::ApprovalRequired, None),
    )
    .await
    .unwrap();
    turn(
        &handle,
        "Start the server.",
        MODEL,
        RuntimeMode::ApprovalRequired,
    )
    .await;
    assert_eq!(
        finished(&until_finished(&mut handle).await),
        TurnOutcome::Done
    );
    let blocked = handle
        .session
        .start_turn(input("two"), &settings(MODEL, RuntimeMode::FullAccess))
        .await;
    match &blocked {
        TurnStartResult::Declined { reason } => {
            assert!(reason.contains("background agents or commands"), "{reason}")
        }
        other => panic!("a reopen ran over a background command: {other:?}"),
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), seen_rx.recv())
        .await
        .expect("the command finished")
        .expect("hook alive");
    turn(&handle, "two", MODEL, RuntimeMode::FullAccess).await;
    let events = until_finished(&mut handle).await;
    assert_eq!(finished(&events), TurnOutcome::Done);
    assert_eq!(
        answers(&events, AssistantMessagePhase::FinalAnswer),
        vec!["two"]
    );
    assert_eq!(run.starts().len(), 2);
    handle.session.shutdown().await;
}

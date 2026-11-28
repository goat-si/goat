//! The driver (goat2-engine-api implementation) against goat2-fake-codex replaying recordings
//! made through the driver itself, plus synthetic variants built from them.

mod support;

use std::sync::Arc;
use std::time::Duration;

use goat2_contracts::{
    EngineConfig, EngineDriver, EngineRef, InputId, ModelSelection, ProviderInstanceId,
    RequestKind, RequestOutcome, RuntimeMode, ThreadId, TurnItemBody,
};
use goat2_engine_api::{
    EngineEvent, EngineFactory, EngineHandle, EngineInput, McpEndpoint, RequestAnswer, SessionSpec,
    SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use goat2_engine_codex::transcript::{Entry, Transcript};
use goat2_engine_codex::transport::TransportConfig;
use goat2_engine_codex::{CodexEngineFactory, CodexEngineOptions};
use serde_json::{Value, json};
use support::fake::{load, write_temp};

const MODEL: &str = "gpt-6-luna";

fn selection() -> ModelSelection {
    serde_json::from_value(json!({"instanceId": "codex", "model": MODEL, "options": [{"id": "reasoningEffort", "value": "low"}]})).unwrap()
}

fn spec(mode: RuntimeMode, resume: Option<&str>) -> SessionSpec {
    SessionSpec {
        thread_id: ThreadId::new("goat-thread-1"),
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("codex"),
            model_selection: selection(),
            runtime_mode: mode,
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        },
        resume: resume.map(|id| EngineRef {
            driver: EngineDriver::Codex,
            id: id.into(),
        }),
        mcp: McpEndpoint {
            url: "http://127.0.0.1:3873/mcp".into(),
            bearer_token: "test-token-0123456789abcdef".into(),
        },
        host_generation: 1,
        process_generation: 1,
    }
}

fn settings(mode: RuntimeMode) -> TurnSettings {
    TurnSettings {
        model_selection: selection(),
        runtime_mode: mode,
    }
}

fn input(id: &str, text: &str) -> Vec<EngineInput> {
    vec![EngineInput {
        input_id: InputId::new(id),
        text: text.into(),
        attachments: Vec::new(),
    }]
}

fn options(transcript: &Transcript) -> CodexEngineOptions {
    let path = write_temp(transcript);
    CodexEngineOptions {
        program: env!("CARGO_BIN_EXE_goat2-fake-codex").into(),
        env_set: vec![("GOAT2_FAKE_CODEX_TRANSCRIPT".into(), path.into_os_string())],
        kill_grace: Duration::from_millis(500),
        client_version: "0.0.0".into(),
        ..CodexEngineOptions::default()
    }
}

async fn start(
    transcript: &Transcript,
    mode: RuntimeMode,
    resume: Option<&str>,
    tune: impl FnOnce(&mut CodexEngineOptions),
) -> EngineHandle {
    let mut o = options(transcript);
    tune(&mut o);
    CodexEngineFactory::new(o)
        .start(spec(mode, resume))
        .await
        .expect("start against the fake codex")
}

async fn next(handle: &mut EngineHandle) -> EngineEvent {
    tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
        .await
        .expect("an engine event in time")
        .expect("events open")
}

/// Collect events until `stop` matches (inclusive). Fails on an unexpected Exited.
async fn until(handle: &mut EngineHandle, stop: impl Fn(&EngineEvent) -> bool) -> Vec<EngineEvent> {
    let mut seen = Vec::new();
    loop {
        let event = next(handle).await;
        let done = stop(&event);
        if let EngineEvent::Exited { reason } = &event
            && !done
        {
            panic!("engine exited early: {reason}\nevents so far: {seen:#?}");
        }
        seen.push(event);
        if done {
            return seen;
        }
    }
}

fn is_finished(e: &EngineEvent) -> bool {
    matches!(e, EngineEvent::TurnFinished { .. })
}

/// Shut down and check the fake saw exactly the expected frames (a mismatch would have ended
/// the process with the fake's message before shutdown).
async fn finish(mut handle: EngineHandle) {
    handle.session.shutdown().await;
    match next(&mut handle).await {
        EngineEvent::Exited { reason } => assert_eq!(reason, "shut down by GOAT"),
        other => panic!("expected Exited after shutdown, got {other:?}"),
    }
}

fn accepted(result: TurnStartResult) -> String {
    match result {
        TurnStartResult::Accepted { turn_id } => turn_id,
        other => panic!("expected Accepted, got {other:?}"),
    }
}

fn entries_until(t: &Transcript, inclusive: impl Fn(&Entry) -> bool) -> Vec<Entry> {
    let mut out = Vec::new();
    for e in &t.entries {
        out.push(e.clone());
        if inclusive(e) {
            return out;
        }
    }
    panic!("marker not found in {}", t.scenario)
}

fn method_of(e: &Entry) -> Option<&str> {
    match e {
        Entry::ExpectOutbound { frame, .. } | Entry::EmitInbound { frame, .. } => {
            frame.get("method").and_then(Value::as_str)
        }
        Entry::RuntimeExit { .. } => None,
    }
}

fn emit(frame: Value) -> Entry {
    Entry::EmitInbound {
        label: None,
        frame,
        after_ms: None,
    }
}

fn expect(frame: Value) -> Entry {
    Entry::ExpectOutbound {
        label: None,
        frame,
        wildcards: Vec::new(),
    }
}

fn synthetic(name: &str, entries: Vec<Entry>) -> Transcript {
    let mut t = Transcript::new(name);
    t.entries = entries;
    t
}

fn recorded_turn(t: &Transcript) -> String {
    t.entries
        .iter()
        .find_map(|e| match e {
            Entry::EmitInbound { frame, .. }
                if frame.get("method") == Some(&json!("turn/started")) =>
            {
                frame
                    .pointer("/params/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }
            _ => None,
        })
        .unwrap()
}

fn recorded_thread(t: &Transcript) -> String {
    t.entries
        .iter()
        .find_map(|e| match e {
            Entry::EmitInbound { frame, .. } => frame
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .unwrap()
}

fn turn_completed(thread: &str, turn: &str, status: &str) -> Entry {
    emit(
        json!({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": turn, "items": [], "status": status, "error": null}}}),
    )
}

// ---- recorded sessions ----

#[tokio::test]
async fn basic_turn_streams_text_and_completes() {
    let t = load("codex-0.167.0/basic.json");
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    assert_eq!(h.engine_ref.id, recorded_thread(&t));
    let turn = accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: GOAT2-OK"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    assert_eq!(turn, recorded_turn(&t));
    let events = until(&mut h, is_finished).await;
    let streamed: String = events
        .iter()
        .filter_map(|e| match e {
            EngineEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "GOAT2-OK");
    let answer = events.iter().find_map(|e| match e {
        EngineEvent::ItemCompleted { item, locator, .. } => match &item.body {
            TurnItemBody::AssistantMessage { text, .. } => Some((text.clone(), locator.clone())),
            _ => None,
        },
        _ => None,
    });
    let (text, locator) = answer.expect("assistant message item");
    assert_eq!(text, "GOAT2-OK");
    assert_eq!(locator.unwrap().turn_id, turn);
    // The user's own message is the host's input, not a driver item (v1 CodexAdapterV2.ts:4326-4333).
    assert!(!events.iter().any(|e| matches!(e, EngineEvent::ItemCompleted { item, .. } if matches!(item.body, TurnItemBody::UserMessage { .. }))));
    assert_eq!(
        events.last(),
        Some(&EngineEvent::TurnFinished {
            turn_id: turn,
            outcome: TurnOutcome::Done
        })
    );
    if cfg!(unix) {
        assert!(h.session.process_group_id().is_some_and(|pgid| pgid > 0));
        assert!(h.session.group_rss_bytes().is_some_and(|rss| rss > 0));
    }
    finish(h).await;
}

#[tokio::test]
async fn resume_reopens_the_recorded_thread_with_goat_mcp() {
    let t = load("codex-0.167.0/resume.json");
    let thread = t
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ExpectOutbound { frame, .. } if frame["method"] == "thread/resume" => frame
                .pointer("/params/threadId")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .unwrap();
    let mut h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |_| {}).await;
    assert_eq!(h.engine_ref.id, thread);
    accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: RESUMED"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    let events = until(&mut h, is_finished).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    finish(h).await;
}

#[tokio::test]
async fn steer_reaches_the_running_turn() {
    let t = load("codex-0.167.0/steer.json");
    let mut h = start(&t, RuntimeMode::AutoAcceptEdits, None, |_| {}).await;
    let turn = accepted(
        h.session
            .start_turn(
                input(
                    "goat-input-1",
                    "Run the shell command `sleep 6` exactly once, then reply with exactly: DONE",
                ),
                &settings(RuntimeMode::AutoAcceptEdits),
            )
            .await,
    );
    let steered = h
        .session
        .steer(
            &turn,
            input(
                "goat-input-2",
                "After that, reply with exactly: DONE STEERED",
            ),
        )
        .await;
    assert_eq!(steered, SteerResult::Accepted);
    let events = until(&mut h, is_finished).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    finish(h).await;
}

#[tokio::test]
async fn interrupt_ends_the_turn_interrupted() {
    let t = load("codex-0.167.0/interrupt.json");
    let mut h = start(&t, RuntimeMode::AutoAcceptEdits, None, |_| {}).await;
    let turn = accepted(
        h.session
            .start_turn(
                input(
                    "goat-input-1",
                    "Run the shell command `sleep 30` exactly once, then reply with exactly: DONE",
                ),
                &settings(RuntimeMode::AutoAcceptEdits),
            )
            .await,
    );
    h.session.interrupt(&turn).await.unwrap();
    let events = until(&mut h, is_finished).await;
    assert_eq!(
        events.last(),
        Some(&EngineEvent::TurnFinished {
            turn_id: turn,
            outcome: TurnOutcome::Interrupted
        })
    );
    finish(h).await;
}

#[tokio::test]
async fn command_approval_round_trip() {
    let t = load("codex-0.167.0/approval.json");
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    let turn = accepted(
        h.session
            .start_turn(input("goat-input-1", "Run exactly this shell command once: touch approved.txt  Then reply with exactly: DONE"), &settings(RuntimeMode::ApprovalRequired))
            .await,
    );
    let events = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened {
        turn_id,
        key,
        item_id,
        kind,
        summary,
        item,
    }) = events.last().cloned()
    else {
        unreachable!()
    };
    assert_eq!(turn_id, turn);
    assert_eq!(kind, RequestKind::Approval);
    assert!(summary.contains("touch approved.txt"), "{summary}");
    let item = item.expect("waiting approval item");
    assert_eq!(Some(item.id.clone()), item_id);
    assert!(
        matches!(&item.body, TurnItemBody::ApprovalRequest { prompt: Some(p), .. } if p.contains("touch approved.txt"))
    );
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Accept,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    let events = until(&mut h, is_finished).await;
    assert!(matches!(
        events.last(),
        Some(EngineEvent::TurnFinished {
            outcome: TurnOutcome::Done,
            ..
        })
    ));
    // An answer for a request of another process generation is refused.
    assert!(
        h.session
            .answer_request(
                "codex:2:0",
                RequestAnswer {
                    outcome: RequestOutcome::Accept,
                    text: None,
                    answers: None
                }
            )
            .await
            .is_err()
    );
    finish(h).await;
}

// ---- synthetic variants ----

fn approval_prefix() -> (Transcript, Vec<Entry>, String, String) {
    let t = load("codex-0.167.0/approval.json");
    let prefix = entries_until(&t, |e| {
        method_of(e) == Some("item/commandExecution/requestApproval")
    });
    let thread = recorded_thread(&t);
    let turn = recorded_turn(&t);
    (t, prefix, thread, turn)
}

async fn start_approval(t: &Transcript, mode: RuntimeMode) -> (EngineHandle, String) {
    let mut h = start(t, mode, None, |_| {}).await;
    let turn = accepted(
        h.session
            .start_turn(input("goat-input-1", "Run exactly this shell command once: touch approved.txt  Then reply with exactly: DONE"), &settings(mode))
            .await,
    );
    let _ = &mut h;
    (h, turn)
}

#[tokio::test]
async fn decline_and_session_allowance() {
    let (_, mut entries, thread, turn) = approval_prefix();
    entries.push(expect(
        json!({"id": 0, "result": {"decision": "acceptForSession"}}),
    ));
    // A second command approval in the same thread and mode is answered by the allowance.
    entries.push(emit(json!({"id": 1, "method": "item/commandExecution/requestApproval", "params": {
        "threadId": thread, "turnId": turn, "itemId": "exec-2", "startedAtMs": 1, "command": "ls"}})));
    entries.push(expect(
        json!({"id": 1, "result": {"decision": "acceptForSession"}}),
    ));
    entries.push(emit(
        json!({"id": 2, "method": "item/fileChange/requestApproval", "params": {
        "threadId": thread, "turnId": turn, "itemId": "patch-1", "startedAtMs": 1}}),
    ));
    entries.push(expect(json!({"id": 2, "result": {"decision": "decline"}})));
    entries.push(turn_completed(&thread, &turn, "completed"));
    let t = synthetic("allowance", entries);
    let (mut h, _) = start_approval(&t, RuntimeMode::ApprovalRequired).await;
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::AcceptForSession,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    // Next visible request is the file change (the command was auto-answered).
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, item, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    assert!(matches!(
        item.unwrap().body,
        TurnItemBody::ApprovalRequest {
            request_kind: goat2_contracts::ProviderRequestKind::FileChange,
            ..
        }
    ));
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Decline,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    until(&mut h, is_finished).await;
    finish(h).await;
}

#[tokio::test]
async fn full_access_auto_accepts_only_without_network() {
    let (_, mut entries, thread, turn) = approval_prefix();
    // Full access changes the turn/start policy fields; ignore them in this synthetic transcript.
    for e in &mut entries {
        if let Entry::ExpectOutbound {
            frame, wildcards, ..
        } = e
            && frame["method"] == "turn/start"
        {
            wildcards.extend(
                [
                    "/params/approvalPolicy",
                    "/params/sandboxPolicy",
                    "/params/approvalsReviewer",
                ]
                .map(String::from),
            );
        }
    }
    // The recorded request has no network context: auto-accepted, no RequestOpened.
    entries.push(expect(json!({"id": 0, "result": {"decision": "accept"}})));
    entries.push(emit(json!({"id": 1, "method": "item/commandExecution/requestApproval", "params": {
        "threadId": thread, "turnId": turn, "itemId": "exec-net", "startedAtMs": 1, "command": "curl example.com",
        "networkApprovalContext": {}}})));
    entries.push(expect(json!({"id": 1, "result": {"decision": "decline"}})));
    entries.push(turn_completed(&thread, &turn, "completed"));
    let t = synthetic("full-access", entries);
    let (mut h, _) = start_approval(&t, RuntimeMode::FullAccess).await;
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, summary, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    assert!(
        summary.contains("curl"),
        "only the network request is shown: {summary}"
    );
    h.session
        .answer_request(
            &key,
            RequestAnswer {
                outcome: RequestOutcome::Decline,
                text: None,
                answers: None,
            },
        )
        .await
        .unwrap();
    until(&mut h, is_finished).await;
    finish(h).await;
}

#[tokio::test]
async fn process_death_closes_open_requests() {
    let (_, mut entries, _, _) = approval_prefix();
    entries.push(Entry::RuntimeExit {
        status: goat2_engine_codex::transcript::ExitKind::Error,
        error: None,
    });
    let t = synthetic("death", entries);
    let (mut h, _) = start_approval(&t, RuntimeMode::ApprovalRequired).await;
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    let rest = until(&mut h, |e| matches!(e, EngineEvent::Exited { .. })).await;
    assert_eq!(rest[0], EngineEvent::RequestClosed { key: key.clone() });
    assert!(matches!(rest.last(), Some(EngineEvent::Exited { .. })));
    assert!(
        h.session
            .answer_request(
                &key,
                RequestAnswer {
                    outcome: RequestOutcome::Accept,
                    text: None,
                    answers: None
                }
            )
            .await
            .is_err()
    );
    assert!(matches!(
        h.session
            .start_turn(input("x", "y"), &settings(RuntimeMode::ApprovalRequired))
            .await,
        TurnStartResult::Declined { .. }
    ));
}

#[tokio::test]
async fn declined_steer_is_reported() {
    let t = load("codex-0.167.0/steer.json");
    let thread = recorded_thread(&t);
    let turn = recorded_turn(&t);
    let mut entries = entries_until(&t, |e| method_of(e) == Some("turn/steer"));
    let steer_id = match entries.last() {
        Some(Entry::ExpectOutbound { frame, .. }) => frame["id"].clone(),
        _ => unreachable!(),
    };
    entries.push(emit(
        json!({"id": steer_id, "error": {"code": -32600, "message": "turn is compacting"}}),
    ));
    entries.push(turn_completed(&thread, &turn, "completed"));
    let t = synthetic("steer-declined", entries);
    let mut h = start(&t, RuntimeMode::AutoAcceptEdits, None, |_| {}).await;
    let turn = accepted(
        h.session
            .start_turn(
                input(
                    "goat-input-1",
                    "Run the shell command `sleep 6` exactly once, then reply with exactly: DONE",
                ),
                &settings(RuntimeMode::AutoAcceptEdits),
            )
            .await,
    );
    let steered = h
        .session
        .steer(
            &turn,
            input(
                "goat-input-2",
                "After that, reply with exactly: DONE STEERED",
            ),
        )
        .await;
    assert_eq!(
        steered,
        SteerResult::Declined {
            reason: "turn is compacting".into()
        }
    );
    until(&mut h, is_finished).await;
    // Steering a turn that is not GOAT's is refused without a frame.
    assert!(matches!(
        h.session
            .steer("someone-elses-turn", input("goat-input-3", "x"))
            .await,
        SteerResult::Declined { .. } | SteerResult::RefusedUnowned { .. }
    ));
    finish(h).await;
}

#[tokio::test]
async fn start_onto_an_unowned_turn_is_refused_without_sending() {
    let t = load("codex-0.167.0/basic.json");
    let thread = recorded_thread(&t);
    let mut entries = entries_until(&t, |e| method_of(e) == Some("thread/started"));
    entries.push(emit(json!({"method": "thread/status/changed", "params": {"threadId": thread, "status": {"type": "active", "activeFlags": []}}})));
    entries.push(emit(json!({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": "foreign-turn", "items": [], "status": "inProgress", "error": null}}})));
    let t = synthetic("unowned", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let result = h
        .session
        .start_turn(
            input("goat-input-1", "Reply with exactly: GOAT2-OK"),
            &settings(RuntimeMode::ApprovalRequired),
        )
        .await;
    assert!(
        matches!(result, TurnStartResult::RefusedUnowned { .. }),
        "{result:?}"
    );
    // No turn/start was sent: the fake had nothing left to expect, so shutdown is clean.
    let _ = &mut h;
    finish(h).await;
}

#[tokio::test]
async fn a_late_turn_start_answer_stops_that_turn() {
    let t = load("codex-0.167.0/basic.json");
    let thread = recorded_thread(&t);
    let mut entries = entries_until(&t, |e| method_of(e) == Some("turn/start"));
    // Nothing was heard after turn/start, so its deadline sends v1's liveness probe; Codex answers it.
    entries.push(expect(
        json!({"id": 5, "method": "config/read", "params": {"cwd": null, "includeLayers": false}}),
    ));
    entries.push(emit(
        json!({"id": 5, "result": {"config": {}, "origins": {}}}),
    ));
    entries.push(Entry::EmitInbound {
        label: None,
        frame: json!({"id": 4, "result": {"turn": {"id": "late-turn", "items": [], "status": "inProgress", "error": null}}}),
        after_ms: Some(600),
    });
    entries.push(expect(json!({"id": 6, "method": "turn/interrupt", "params": {"threadId": thread, "turnId": "late-turn"}})));
    entries.push(emit(json!({"id": 6, "result": {}})));
    let t = synthetic("late-start", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |o| {
        o.env_set
            .push(("GOAT2_FAKE_CODEX_REALTIME".into(), "1".into()));
        o.transport = TransportConfig {
            deadline_for: Arc::new(|method| match method {
                "turn/start" => Some(Duration::from_millis(250)),
                _ => goat2_engine_codex::transport::deadline_for(method),
            }),
            liveness_window: Duration::from_secs(5),
        };
    })
    .await;
    let result = h
        .session
        .start_turn(
            input("goat-input-1", "Reply with exactly: GOAT2-OK"),
            &settings(RuntimeMode::ApprovalRequired),
        )
        .await;
    assert!(
        matches!(result, TurnStartResult::Unknown { .. }),
        "{result:?}"
    );
    // The fake now expects the turn/interrupt for the late turn; give it time to arrive.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let _ = &mut h;
    finish(h).await;
}

#[tokio::test]
async fn idle_process_stops() {
    let t = load("codex-0.167.0/basic.json");
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |o| {
        o.idle_timeout = Some(Duration::from_millis(300))
    })
    .await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: GOAT2-OK"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    until(&mut h, is_finished).await;
    match next(&mut h).await {
        EngineEvent::Exited { reason } => assert_eq!(reason, "idle"),
        other => panic!("expected an idle exit, got {other:?}"),
    }
}

// ---- review round 1 regressions ----

#[tokio::test]
async fn resume_onto_an_active_thread_lists_turns_and_refuses() {
    // v1 CodexTurnStartGuard.ts:58-73,113-116: a resume that reports the thread busy is checked
    // with thread/turns/list before any start; a running turn GOAT never owned refuses the start.
    let t = load("codex-0.167.0/resume.json");
    let thread = recorded_thread(&t);
    let mut entries = entries_until(
        &t,
        |e| matches!(e, Entry::EmitInbound { frame, .. } if frame.pointer("/result/thread/id").is_some()),
    );
    if let Some(Entry::EmitInbound { frame, .. }) = entries.last_mut() {
        frame["result"]["thread"]["status"] = json!({"type": "active", "activeFlags": []});
    }
    entries.push(expect(
        json!({"id": 50, "method": "thread/turns/list", "params": {
        "threadId": thread, "limit": 10, "sortDirection": "desc", "itemsView": "summary"}}),
    ));
    entries.push(emit(json!({"id": 50, "result": {"data": [
        {"id": "foreign-turn", "items": [], "status": "inProgress", "error": null}]}})));
    let t = synthetic("resume-active", entries);
    let h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |_| {}).await;
    let result = h
        .session
        .start_turn(
            input("goat-input-1", "Reply with exactly: RESUMED"),
            &settings(RuntimeMode::ApprovalRequired),
        )
        .await;
    assert!(
        matches!(result, TurnStartResult::RefusedUnowned { .. }),
        "{result:?}"
    );
    // No turn/start went out: the fake had nothing more to expect.
    finish(h).await;
}

/// A later turn/start in another runtime mode: the recorded frame with the mode-dependent
/// fields left open, answered with a fresh turn.
fn later_turn(template: &Value, rpc: u64, thread: &str, turn: &str) -> Vec<Entry> {
    // v1 reads the reasoning-summary setting before every start (CodexAdapterV2.ts:6597-6606).
    let read = Entry::ExpectOutbound {
        label: None,
        frame: json!({"id": rpc + 1000, "method": "config/read", "params": {
            "cwd": template["params"]["cwd"], "includeLayers": false}}),
        wildcards: vec!["/params/cwd".into()],
    };
    let read_answer = emit(json!({"id": rpc + 1000, "result": {"config": {}}}));
    let mut frame = template.clone();
    frame["id"] = json!(rpc);
    let start = Entry::ExpectOutbound {
        label: None,
        frame,
        wildcards: [
            "/params/approvalPolicy",
            "/params/sandboxPolicy",
            "/params/approvalsReviewer",
            "/params/input",
            "/params/clientUserMessageId",
        ]
        .map(String::from)
        .to_vec(),
    };
    let info = json!({"id": turn, "items": [], "status": "inProgress", "error": null});
    vec![
        read,
        read_answer,
        start,
        emit(json!({"id": rpc, "result": {"turn": info.clone()}})),
        emit(json!({"method": "turn/started", "params": {"threadId": thread, "turn": info}})),
    ]
}

#[tokio::test]
async fn session_allowance_ends_on_a_mode_round_trip() {
    // v1 CodexAdapterV2.ts:1150-1158: any mode change ends the session allowances, so
    // approval-required -> auto-accept-edits -> approval-required asks again.
    let (t, mut entries, thread, turn) = approval_prefix();
    let template = t
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ExpectOutbound { frame, .. } if frame["method"] == "turn/start" => {
                Some(frame.clone())
            }
            _ => None,
        })
        .unwrap();
    entries.push(expect(
        json!({"id": 0, "result": {"decision": "acceptForSession"}}),
    ));
    // Codex reports the thread idle just before turn/completed (recorded order).
    entries.push(thread_idle(&thread));
    entries.push(turn_completed(&thread, &turn, "completed"));
    entries.extend(later_turn(&template, 60, &thread, "turn-2"));
    entries.push(thread_idle(&thread));
    entries.push(turn_completed(&thread, "turn-2", "completed"));
    entries.extend(later_turn(&template, 61, &thread, "turn-3"));
    entries.push(emit(json!({"id": 9, "method": "item/commandExecution/requestApproval", "params": {
        "threadId": thread, "turnId": "turn-3", "itemId": "exec-3", "startedAtMs": 1, "command": "ls"}})));
    entries.push(expect(json!({"id": 9, "result": {"decision": "decline"}})));
    entries.push(turn_completed(&thread, "turn-3", "completed"));
    let t = synthetic("allowance-mode-round-trip", entries);

    let (mut h, _) = start_approval(&t, RuntimeMode::ApprovalRequired).await;
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    let answer = |outcome| RequestAnswer {
        outcome,
        text: None,
        answers: None,
    };
    h.session
        .answer_request(&key, answer(RequestOutcome::AcceptForSession))
        .await
        .unwrap();
    until(&mut h, is_finished).await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-2", "again"),
                &settings(RuntimeMode::AutoAcceptEdits),
            )
            .await,
    );
    until(&mut h, is_finished).await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-3", "again"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    // Back in approval-required, the command is asked again instead of auto-accepted.
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    h.session
        .answer_request(&key, answer(RequestOutcome::Decline))
        .await
        .unwrap();
    until(&mut h, is_finished).await;
    finish(h).await;
}

fn thread_idle(thread: &str) -> Entry {
    emit(
        json!({"method": "thread/status/changed", "params": {"threadId": thread, "status": {"type": "idle"}}}),
    )
}

/// resume.json up to the resume answer, with the answer reporting the thread busy. Codex
/// 0.167.0 sends an idle thread/status/changed before that answer (recorded order).
fn busy_resume_prefix() -> (Vec<Entry>, String) {
    let t = load("codex-0.167.0/resume.json");
    let thread = recorded_thread(&t);
    let mut entries = entries_until(
        &t,
        |e| matches!(e, Entry::EmitInbound { frame, .. } if frame.pointer("/result/thread/id").is_some()),
    );
    if let Some(Entry::EmitInbound { frame, .. }) = entries.last_mut() {
        frame["result"]["thread"]["status"] = json!({"type": "active", "activeFlags": []});
    }
    (entries, thread)
}

fn turns_list(rpc: u64, thread: &str) -> Entry {
    expect(json!({"id": rpc, "method": "thread/turns/list", "params": {
        "threadId": thread, "limit": 10, "sortDirection": "desc", "itemsView": "summary"}}))
}

fn foreign_running(rpc: u64) -> Entry {
    emit(json!({"id": rpc, "result": {"data": [
        {"id": "foreign-turn", "items": [], "status": "inProgress", "error": null}]}}))
}

async fn refused_start(h: &EngineHandle, id: &str) {
    let result = h
        .session
        .start_turn(input(id, "hi"), &settings(RuntimeMode::ApprovalRequired))
        .await;
    assert!(
        matches!(result, TurnStartResult::RefusedUnowned { .. }),
        "{result:?}"
    );
}

#[tokio::test]
async fn a_failed_turn_list_after_a_busy_resume_keeps_every_retry_guarded() {
    // v1 classify (CodexTurnStartGuard.ts:78-105): busy with no turn named fails closed. The
    // busy resume stays unsettled until a readable list, so the retry lists again.
    let (mut entries, thread) = busy_resume_prefix();
    entries.push(turns_list(50, &thread));
    entries.push(emit(
        json!({"id": 50, "error": {"code": -32603, "message": "list failed"}}),
    ));
    entries.push(turns_list(51, &thread));
    entries.push(emit(json!({"id": 51, "result": {"data": "not a list"}})));
    entries.push(turns_list(52, &thread));
    entries.push(emit(json!({"id": 52, "result": {}})));
    entries.push(turns_list(53, &thread));
    entries.push(emit(
        json!({"id": 53, "result": {"data": [{"id": "foreign-turn", "items": []}]}}),
    ));
    entries.push(turns_list(54, &thread));
    entries.push(foreign_running(54));
    let t = synthetic("busy-resume-list-failures", entries);
    let h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |_| {}).await;
    refused_start(&h, "goat-input-1").await; // list error
    refused_start(&h, "goat-input-2").await; // data of the wrong type
    refused_start(&h, "goat-input-3").await; // data missing
    refused_start(&h, "goat-input-4").await; // a turn without its status
    refused_start(&h, "goat-input-5").await; // the foreign turn, listed
    // No turn/start ever went out: the fake had nothing more to expect.
    finish(h).await;
}

#[tokio::test]
async fn idle_stop_spares_a_resumed_turn_goat_does_not_own() {
    // The idle clock lists turns instead of stopping a process whose resume answered busy; a
    // running native turn keeps the process (stopping it would kill that turn).
    let (mut entries, thread) = busy_resume_prefix();
    entries.push(turns_list(50, &thread));
    entries.push(foreign_running(50));
    let t = synthetic("busy-resume-idle", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |o| {
        o.idle_timeout = Some(Duration::from_millis(200));
    })
    .await;
    let quiet = tokio::time::timeout(Duration::from_millis(1500), h.events.recv()).await;
    assert!(quiet.is_err(), "no event (and no idle exit): {quiet:?}");
    // Still alive and still guarded: the listed foreign turn refuses a start without a resend.
    refused_start(&h, "goat-input-1").await;
    finish(h).await;
}

#[tokio::test]
async fn a_late_session_answer_across_a_mode_round_trip_records_nothing() {
    // v1 binds an answer to the approval set of its request (CodexAdapterV2.ts:1144-1170): a
    // request opened in A, answered after A -> B -> A, must not revive a session allowance.
    let (t, mut entries, thread, turn) = approval_prefix();
    let template = t
        .entries
        .iter()
        .find_map(|e| match e {
            Entry::ExpectOutbound { frame, .. } if frame["method"] == "turn/start" => {
                Some(frame.clone())
            }
            _ => None,
        })
        .unwrap();
    // The turn ends with the request still open.
    entries.push(thread_idle(&thread));
    entries.push(turn_completed(&thread, &turn, "completed"));
    entries.extend(later_turn(&template, 60, &thread, "turn-2"));
    entries.push(thread_idle(&thread));
    entries.push(turn_completed(&thread, "turn-2", "completed"));
    entries.extend(later_turn(&template, 61, &thread, "turn-3"));
    entries.push(expect(
        json!({"id": 0, "result": {"decision": "acceptForSession"}}),
    ));
    entries.push(emit(json!({"id": 9, "method": "item/commandExecution/requestApproval", "params": {
        "threadId": thread, "turnId": "turn-3", "itemId": "exec-3", "startedAtMs": 1, "command": "ls"}})));
    entries.push(expect(json!({"id": 9, "result": {"decision": "decline"}})));
    entries.push(turn_completed(&thread, "turn-3", "completed"));
    let t = synthetic("late-answer-mode-round-trip", entries);

    let (mut h, _) = start_approval(&t, RuntimeMode::ApprovalRequired).await;
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key: old, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    until(&mut h, is_finished).await;
    for (id, mode) in [
        ("goat-input-2", RuntimeMode::AutoAcceptEdits),
        ("goat-input-3", RuntimeMode::ApprovalRequired),
    ] {
        accepted(
            h.session
                .start_turn(input(id, "again"), &settings(mode))
                .await,
        );
        if mode == RuntimeMode::AutoAcceptEdits {
            until(&mut h, is_finished).await;
        }
    }
    let answer = |outcome| RequestAnswer {
        outcome,
        text: None,
        answers: None,
    };
    h.session
        .answer_request(&old, answer(RequestOutcome::AcceptForSession))
        .await
        .unwrap();
    // The next command in A is asked, not auto-accepted by the late answer.
    let opened = until(&mut h, |e| matches!(e, EngineEvent::RequestOpened { .. })).await;
    let Some(EngineEvent::RequestOpened { key, .. }) = opened.last().cloned() else {
        unreachable!()
    };
    h.session
        .answer_request(&key, answer(RequestOutcome::Decline))
        .await
        .unwrap();
    until(&mut h, is_finished).await;
    finish(h).await;
}

fn emit_after(frame: Value, ms: u64) -> Entry {
    Entry::EmitInbound {
        label: None,
        frame,
        after_ms: Some(ms),
    }
}

fn realtime(o: &mut CodexEngineOptions) {
    o.env_set
        .push(("GOAT2_FAKE_CODEX_REALTIME".into(), "1".into()));
}

#[tokio::test]
async fn a_stop_while_the_guard_checks_cancels_the_start_and_kills_nothing() {
    // Nothing was sent, so the stop only cancels the start; no stop timer may end the process
    // (a foreign turn may be running in it).
    let (mut entries, thread) = busy_resume_prefix();
    entries.push(turns_list(50, &thread));
    entries.push(emit_after(
        json!({"id": 50, "result": {"data": [
            {"id": "foreign-turn", "items": [], "status": "inProgress", "error": null}]}}),
        800,
    ));
    let t = synthetic("stop-while-guarding", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |o| {
        realtime(o);
        o.stop_grace = Duration::from_millis(300);
    })
    .await;
    let approval = settings(RuntimeMode::ApprovalRequired);
    let (result, stopped) = tokio::join!(
        h.session.start_turn(input("goat-input-1", "hi"), &approval),
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            h.session.interrupt("any").await
        }
    );
    stopped.unwrap();
    assert!(
        matches!(result, TurnStartResult::Declined { .. }),
        "{result:?}"
    );
    let quiet = tokio::time::timeout(Duration::from_millis(1500), h.events.recv()).await;
    assert!(quiet.is_err(), "no stop-timer exit: {quiet:?}");
    // The listed foreign turn still guards the next start.
    refused_start(&h, "goat-input-2").await;
    finish(h).await;
}

#[tokio::test]
async fn a_stop_while_codex_declines_the_start_clears_the_stop_timer() {
    let t = load("codex-0.167.0/basic.json");
    let mut entries = entries_until(&t, |e| method_of(e) == Some("turn/start"));
    let rpc = match entries.last() {
        Some(Entry::ExpectOutbound { frame, .. }) => frame["id"].clone(),
        _ => unreachable!(),
    };
    entries.push(emit_after(
        json!({"id": rpc, "error": {"code": -32600, "message": "not now"}}),
        300,
    ));
    let t = synthetic("stop-while-declined", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |o| {
        realtime(o);
        o.stop_grace = Duration::from_millis(600);
    })
    .await;
    let approval = settings(RuntimeMode::ApprovalRequired);
    let (result, stopped) = tokio::join!(
        h.session.start_turn(
            input("goat-input-1", "Reply with exactly: GOAT2-OK"),
            &approval
        ),
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            h.session.interrupt("any").await
        }
    );
    stopped.unwrap();
    assert_eq!(
        result,
        TurnStartResult::Declined {
            reason: "not now".into()
        }
    );
    let quiet = tokio::time::timeout(Duration::from_millis(1200), h.events.recv()).await;
    assert!(quiet.is_err(), "no stop-timer exit: {quiet:?}");
    finish(h).await;
}

#[tokio::test]
async fn a_turn_list_overtaken_by_an_idle_status_is_ignored() {
    // v1 re-checks the thread after the list (CodexTurnStartGuard.ts:78-86): a thread that went
    // idle while the list was in flight is free, whatever the list said.
    let t = load("codex-0.167.0/resume.json");
    let (mut entries, thread) = busy_resume_prefix();
    entries.push(turns_list(50, &thread));
    entries.push(thread_idle(&thread));
    entries.push(emit_after(
        json!({"id": 50, "result": {"data": [
            {"id": "foreign-turn", "items": [], "status": "inProgress", "error": null}]}}),
        50,
    ));
    let from = t
        .entries
        .iter()
        .position(|e| method_of(e) == Some("config/read"))
        .unwrap();
    entries.extend(t.entries[from..].iter().cloned());
    let t = synthetic("stale-list", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, Some(&thread), |_| {}).await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: RESUMED"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    until(&mut h, is_finished).await;
    finish(h).await;
}

/// basic.json with its config/read answer and expected turn/start summary rewritten.
fn basic_with_config(answer: Value, summary: &str) -> Transcript {
    let mut t = load("codex-0.167.0/basic.json");
    let mut read_id = None;
    for e in &mut t.entries {
        match e {
            Entry::ExpectOutbound { frame, .. } if frame["method"] == "config/read" => {
                read_id = Some(frame["id"].clone());
            }
            Entry::EmitInbound { frame, .. }
                if read_id.is_some() && frame.get("id") == read_id.as_ref() =>
            {
                let id = frame["id"].clone();
                *frame = answer.clone();
                frame["id"] = id;
                read_id = None;
            }
            Entry::ExpectOutbound { frame, .. } if frame["method"] == "turn/start" => {
                frame["params"]["summary"] = json!(summary);
            }
            _ => {}
        }
    }
    t
}

#[tokio::test]
async fn each_start_uses_the_reasoning_summary_read_just_before_it() {
    // v1 reads model_reasoning_summary before every start (CodexAdapterV2.ts:6597-6606).
    let t = basic_with_config(
        json!({"result": {"config": {"model_reasoning_summary": "detailed"}}}),
        "detailed",
    );
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: GOAT2-OK"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    until(&mut h, is_finished).await;
    finish(h).await;
}

#[tokio::test]
async fn a_failed_config_read_still_starts_with_the_default_summary() {
    let t = basic_with_config(
        json!({"error": {"code": -32603, "message": "config unavailable"}}),
        "auto",
    );
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    accepted(
        h.session
            .start_turn(
                input("goat-input-1", "Reply with exactly: GOAT2-OK"),
                &settings(RuntimeMode::ApprovalRequired),
            )
            .await,
    );
    until(&mut h, is_finished).await;
    finish(h).await;
}

#[tokio::test]
async fn an_unexpected_exit_reports_codex_last_stderr_lines() {
    // The fake names a mismatching frame on stderr and exits; the Exited reason carries it.
    let t = load("codex-0.167.0/basic.json");
    let mut entries = entries_until(&t, |e| method_of(e) == Some("thread/started"));
    entries.push(expect(
        json!({"id": 9, "method": "thread/read", "params": {}}),
    ));
    let t = synthetic("exit-stderr", entries);
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    let _ = h
        .session
        .start_turn(
            input("goat-input-1", "hi"),
            &settings(RuntimeMode::ApprovalRequired),
        )
        .await;
    let events = until(&mut h, |e| matches!(e, EngineEvent::Exited { .. })).await;
    let Some(EngineEvent::Exited { reason }) = events.last() else {
        unreachable!()
    };
    assert!(
        reason.contains("stderr: goat2-fake-codex") && reason.contains("mismatch at /method"),
        "{reason}"
    );
}

fn image_attachment(id: &str) -> goat2_contracts::ChatAttachment {
    goat2_contracts::ChatAttachment {
        kind: goat2_contracts::ChatAttachmentType::Image,
        id: id.into(),
        name: "a.png".into(),
        mime_type: "image/png".into(),
        size_bytes: 3,
        blob: None,
    }
}

#[tokio::test]
async fn an_image_that_cannot_be_found_declines_before_sending() {
    // v1 CodexAdapterV2.ts:2639-2645: an unresolvable image is an error, never a silent drop.
    let t = load("codex-0.167.0/basic.json");
    let entries = entries_until(&t, |e| method_of(e) == Some("thread/started"));
    let t = synthetic("attachment-missing", entries);
    let h = start(&t, RuntimeMode::ApprovalRequired, None, |_| {}).await;
    let mut inputs = input("goat-input-1", "Look");
    inputs[0].attachments.push(image_attachment("att-1"));
    let result = h
        .session
        .start_turn(inputs, &settings(RuntimeMode::ApprovalRequired))
        .await;
    assert_eq!(
        result,
        TurnStartResult::Declined {
            reason: "Invalid attachment id 'att-1'".into()
        }
    );
    finish(h).await;
}

#[tokio::test]
async fn an_image_attachment_is_sent_as_a_data_url_with_its_path_in_the_text() {
    let dir = std::env::temp_dir().join(format!("goat2-attach-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.png");
    std::fs::write(&file, b"foo").unwrap();
    let mut t = load("codex-0.167.0/basic.json");
    for e in &mut t.entries {
        if let Entry::ExpectOutbound { frame, .. } = e
            && frame["method"] == "turn/start"
        {
            frame["params"]["input"] = json!([
                {"type": "text", "text_elements": [], "text": format!(
                    "Reply with exactly: GOAT2-OK\n\n[Attached image \"a.png\" is saved at: {}]",
                    file.display())},
                {"type": "image", "url": "data:image/png;base64,Zm9v"}
            ]);
        }
    }
    let resolved = file.clone();
    let mut h = start(&t, RuntimeMode::ApprovalRequired, None, move |o| {
        o.attachment_resolver = Some(Arc::new(move |thread, attachment| {
            assert_eq!(thread, &ThreadId::new("goat-thread-1"));
            (attachment.id == "att-1").then(|| resolved.clone())
        }));
    })
    .await;
    let mut inputs = input("goat-input-1", "Reply with exactly: GOAT2-OK");
    inputs[0].attachments.push(image_attachment("att-1"));
    accepted(
        h.session
            .start_turn(inputs, &settings(RuntimeMode::ApprovalRequired))
            .await,
    );
    until(&mut h, is_finished).await;
    finish(h).await;
    let _ = std::fs::remove_dir_all(&dir);
}

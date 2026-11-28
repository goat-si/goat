//! Bot runtime on the fake engine (PRD part2 done criteria 1-4 and 8): the session brief and
//! its rotation, the 20 s / 55 s receipt guards, answer-and-done, ack then result, steering a
//! person's message into a running bot turn.

use std::sync::Arc;
use std::time::{Duration, Instant};

use goat2_contracts::{
    BotRole, ClientFrame, InputMode, ItemId, LogEvent, NotifyKind, ThreadId, TurnItemBody,
    UserNotified,
};
use goat2_host::api::{Caller, McpHost, SurfaceResult, UserSendArgs, WsHost};
use goat2_host::bot::guards::{GuardOptions, SESSION_WORKING};
use goat2_host::bot::notes;
use goat2_host::core::{Host, HostOptions};
use goat2_host::engine::EngineEvent;
use goat2_host::engine::fake::{FakeCall, FakeEngine, FakeScript, assistant_item};
use goat2_host::stall::StallRecorder;
use goat2_host::store::LaneAStore;

struct T {
    host: Host,
    fake: FakeEngine,
    dir: tempfile::TempDir,
}

fn guards() -> GuardOptions {
    GuardOptions {
        ack_after: Duration::from_millis(300),
        fixed_after: Duration::from_millis(900),
        check_every: Duration::from_millis(50),
    }
}

async fn setup_with(steering: bool) -> T {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let (store, _) = LaneAStore::open(&path).unwrap();
    let stall = StallRecorder::open(&path).unwrap();
    let fake = FakeEngine::new(FakeScript {
        auto_finish: false,
        ..FakeScript::default()
    });
    let opts = HostOptions {
        idle_stop: Duration::from_secs(30),
        bot_guards: guards(),
        ..HostOptions::new(path.clone(), 1, "ui-token".into(), "/tmp".into())
    };
    if !steering {
        fake.without_steering();
    }
    let host = Host::open(opts, Arc::new(store), Arc::new(fake.clone()), stall).unwrap();
    host.set_mcp_url("http://127.0.0.1:1/mcp".into());
    host.start(&[]).await.unwrap();
    T { host, fake, dir }
}

async fn setup() -> T {
    setup_with(true).await
}

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "timed out waiting for: {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn bot(t: &T) -> (goat2_contracts::BotProfile, ThreadId) {
    let b = t
        .host
        .bots()
        .into_iter()
        .find(|b| b.role == BotRole::Main)
        .unwrap();
    let id = b.session_thread_id.clone();
    (b, id)
}

async fn say(t: &T, id: &ThreadId, key: &str, text: &str) {
    t.host
        .command(ClientFrame::SendInput {
            req_id: format!("r-{key}"),
            client_request_id: key.into(),
            thread_id: id.clone(),
            text: text.into(),
            mode: InputMode::Followup,
            attachments: None,
        })
        .await
        .unwrap();
}

/// A person's message with no mode: the thread decides (bots steer when the engine can).
async fn say_default(t: &T, id: &ThreadId, key: &str, text: &str) {
    let frame: ClientFrame = serde_json::from_value(serde_json::json!({
        "type": "send_input",
        "reqId": format!("r-{key}"),
        "clientRequestId": key,
        "threadId": id,
        "text": text,
    }))
    .unwrap_or_else(|_| ClientFrame::SendInput {
        req_id: format!("r-{key}"),
        client_request_id: key.into(),
        thread_id: id.clone(),
        text: text.into(),
        mode: InputMode::Followup,
        attachments: None,
    });
    t.host.command(frame).await.unwrap();
}

fn notified(t: &T, id: &ThreadId) -> Vec<UserNotified> {
    t.host
        .store()
        .read_after(id, 0)
        .unwrap()
        .into_iter()
        .filter_map(|l| match l.event {
            LogEvent::UserNotified(n) => Some(n),
            _ => None,
        })
        .collect()
}

fn starts(t: &T, id: &ThreadId) -> Vec<Option<String>> {
    t.fake
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            FakeCall::Start {
                thread_id, resume, ..
            } if &thread_id == id => Some(resume),
            _ => None,
        })
        .collect()
}

fn running(t: &T, id: &ThreadId) -> bool {
    t.fake.active_turn(id).is_some()
}

async fn caller(t: &T, id: &ThreadId) -> Caller {
    let token = t
        .fake
        .calls()
        .into_iter()
        .rev()
        .find_map(|c| match c {
            FakeCall::Start {
                thread_id,
                mcp_token,
                ..
            } if &thread_id == id => Some(mcp_token),
            _ => None,
        })
        .unwrap();
    let grant = t.host.grant(&token).unwrap();
    let start = Instant::now();
    loop {
        if let Ok(c) = t.host.caller(&grant).await {
            return c;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn send_to_user(t: &T, c: &Caller, kind: NotifyKind, text: &str) -> SurfaceResult {
    t.host
        .user_send(
            c,
            UserSendArgs {
                kind,
                text: text.into(),
            },
        )
        .await
}

fn command_item(t: &T, id: &ThreadId, command: &str) -> EngineEvent {
    let turn_id = t.fake.active_turn(id).unwrap();
    let mut item = assistant_item(id, &ItemId::new("cmd-1"), &turn_id, "");
    item.body = TurnItemBody::CommandExecution {
        input: command.into(),
        command_actions: None,
        output: None,
        output_omitted: None,
        output_indicates_failure: None,
        exit_code: Some(0),
    };
    EngineEvent::ItemCompleted {
        turn_id,
        item: Box::new(item),
        locator: None,
    }
}

#[tokio::test]
async fn hello_gets_one_answer_and_the_first_turn_carries_the_brief() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "hi-1", "hello").await;
    eventually("running", || running(&t, &id)).await;
    let brief = t.fake.turn_texts(&id).remove(0);
    assert!(brief.contains("## Standing instructions\nYou are GOAT Bot's working session"));
    assert!(brief.contains("goat_send_to_user"));
    assert!(brief.ends_with("## Current message\nhello"), "{brief}");
    // Answer and done: no tool call, the final answer is the one reply.
    t.fake.finish_turn(&id, "Hi! What can I do for you?");
    eventually("result", || !notified(&t, &id).is_empty()).await;
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let sent = notified(&t, &id);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].kind, NotifyKind::Result);
    assert_eq!(sent[0].text, "Hi! What can I do for you?");
}

#[tokio::test]
async fn ack_first_then_result_and_no_second_ack() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "fix-1", "fix the tests in this repo").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(
            &t,
            &me,
            NotifyKind::Ack,
            "Starting a worker to fix the tests."
        )
        .await
        .is_ok()
    );
    let again = send_to_user(&t, &me, NotifyKind::Ack, "again").await;
    assert!(matches!(again, SurfaceResult::Error { ref error } if error.reason == "already_sent"));
    // The final message repeats the ack line: only what follows is sent as the result.
    t.fake.finish_turn(
        &id,
        "Starting a worker to fix the tests. I'll report when it is done.",
    );
    eventually("result", || notified(&t, &id).len() == 2).await;
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let sent = notified(&t, &id);
    assert_eq!(sent.len(), 2, "{sent:?}");
    assert_eq!(sent[0].kind, NotifyKind::Ack);
    assert_eq!(sent[1].kind, NotifyKind::Result);
    assert_eq!(sent[1].text, "I'll report when it is done.");
}

#[tokio::test]
async fn a_working_session_without_its_line_gets_the_20s_progress_line_only() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "work-1", "check the build").await;
    eventually("running", || running(&t, &id)).await;
    t.fake.emit(&id, command_item(&t, &id, "cargo build"));
    eventually("fallback", || !notified(&t, &id).is_empty()).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let sent = notified(&t, &id);
    assert_eq!(sent.len(), 1, "one receipt per message: {sent:?}");
    assert_eq!(sent[0].kind, NotifyKind::Ack);
    assert_eq!(sent[0].text, "Still on it. So far I ran cargo build.");
    // The session's own ack is refused now: the message already has its receipt.
    let me = caller(&t, &id).await;
    let late = send_to_user(&t, &me, NotifyKind::Ack, "on it").await;
    assert!(matches!(late, SurfaceResult::Error { ref error } if error.reason == "already_sent"));
    assert!(
        send_to_user(&t, &me, NotifyKind::Result, "Build passes.")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_silent_session_gets_the_55s_fixed_line() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "quiet-1", "think about it").await;
    eventually("running", || running(&t, &id)).await;
    // Composing (nothing done yet): no 20 s line.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(notified(&t, &id).is_empty());
    eventually("fixed line", || !notified(&t, &id).is_empty()).await;
    let sent = notified(&t, &id);
    assert_eq!(sent[0].text, SESSION_WORKING);
    assert!(sent[0].run_id.is_some());
}

#[tokio::test]
async fn the_sessions_own_ack_stops_both_guards() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "ok-1", "look at the logs").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(&t, &me, NotifyKind::Ack, "Reading the logs.")
            .await
            .is_ok()
    );
    t.fake.emit(&id, command_item(&t, &id, "tail log"));
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(notified(&t, &id).len(), 1);
}

#[tokio::test]
async fn a_message_during_a_bot_turn_is_steered_in_when_the_engine_can() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "s-1", "start the long thing").await;
    eventually("running", || running(&t, &id)).await;
    say_default(&t, &id, "s-2", "also, what time is it?").await;
    eventually("steered", || {
        t.fake
            .calls()
            .iter()
            .any(|c| matches!(c, FakeCall::Steer { thread_id, .. } if thread_id == &id))
    })
    .await;
    // Each message gets its own result in the same run.
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(&t, &me, NotifyKind::Ack, "Starting.")
            .await
            .is_ok()
    );
    assert!(
        send_to_user(&t, &me, NotifyKind::Result, "It is noon.")
            .await
            .is_ok()
    );
    let third = send_to_user(&t, &me, NotifyKind::Result, "again").await;
    assert!(matches!(third, SurfaceResult::Error { ref error } if error.reason == "already_sent"));
}

#[tokio::test]
async fn without_steering_a_queued_message_gets_the_queued_line_at_20s() {
    let t = setup_with(false).await;
    let (_, id) = bot(&t);
    say(&t, &id, "q-1", "start the long thing").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(&t, &me, NotifyKind::Ack, "Starting.")
            .await
            .is_ok()
    );
    say_default(&t, &id, "q-2", "and another thing").await;
    eventually("queued line", || notified(&t, &id).len() == 2).await;
    let sent = notified(&t, &id);
    assert!(
        sent[1].text.contains("finish the one before it"),
        "{sent:?}"
    );
    assert!(sent[1].run_id.is_none());
    assert!(
        !t.fake
            .calls()
            .iter()
            .any(|c| matches!(c, FakeCall::Steer { .. }))
    );
}

#[tokio::test]
async fn notes_are_in_the_brief_and_a_changed_note_rotates_the_session() {
    let t = setup().await;
    let (b, id) = bot(&t);
    let path = notes::notes_path(t.dir.path(), b.bot_id.as_str());
    notes::append(&path, "The person's name is Jun", "2026-11-28", None, None).unwrap();
    say(&t, &id, "n-1", "who am I?").await;
    eventually("running", || running(&t, &id)).await;
    assert!(
        t.fake.turn_texts(&id)[0].contains("## Standing notes\nA note line ending in (replaces")
    );
    assert!(t.fake.turn_texts(&id)[0].contains("- 2026-11-28: The person's name is Jun"));
    t.fake.finish_turn(&id, "You are Jun.");
    eventually("idle", || {
        !running(&t, &id) && !notified(&t, &id).is_empty()
    })
    .await;
    // Same notes: the live session takes the next message as is.
    say(&t, &id, "n-2", "thanks").await;
    eventually("second turn", || t.fake.turn_texts(&id).len() == 2).await;
    assert_eq!(t.fake.turn_texts(&id)[1], "thanks");
    assert_eq!(starts(&t, &id).len(), 1);
    t.fake.finish_turn(&id, "Any time.");
    eventually("idle", || !running(&t, &id)).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // A new note: the next message starts a fresh, briefed session.
    notes::append(&path, "Jun prefers short answers", "2026-11-28", None, None).unwrap();
    say(&t, &id, "n-3", "hello again").await;
    eventually("third turn", || t.fake.turn_texts(&id).len() == 3).await;
    let s = starts(&t, &id);
    assert_eq!(s.len(), 2, "{s:?}");
    assert_eq!(s[1], None, "rotation starts without resume");
    let third = &t.fake.turn_texts(&id)[2];
    assert!(third.contains("Jun prefers short answers"));
    assert!(third.contains("## Recent conversation\nPerson: who am I?\nGOAT Bot: You are Jun.\nPerson: thanks\nGOAT Bot: Any time."), "{third}");
}

async fn reopen(t: T) -> T {
    let T { host, fake, dir } = t;
    host.shutdown().await;
    drop(host);
    let path = dir.path().to_path_buf();
    let (store, report) = LaneAStore::open(&path).unwrap();
    let settled: Vec<ThreadId> = report
        .settled
        .iter()
        .map(|s| ThreadId::new(s.thread_id.clone()))
        .collect();
    let stall = StallRecorder::open(&path).unwrap();
    let opts = HostOptions {
        idle_stop: Duration::from_secs(30),
        bot_guards: guards(),
        ..HostOptions::new(path.clone(), 2, "ui-token".into(), "/tmp".into())
    };
    let host = Host::open(opts, Arc::new(store), Arc::new(fake.clone()), stall).unwrap();
    host.set_mcp_url("http://127.0.0.1:1/mcp".into());
    host.start(&settled).await.unwrap();
    T { host, fake, dir }
}

fn option(label: &str) -> goat2_contracts::UserInputOption {
    goat2_contracts::UserInputOption {
        label: label.into(),
        description: format!("about {label}"),
        value: None,
        preview: None,
    }
}

fn question(id: &str, labels: &[&str]) -> goat2_contracts::UserInputQuestion {
    goat2_contracts::UserInputQuestion {
        id: id.into(),
        header: id.into(),
        question: format!("Which {id}?"),
        options: labels.iter().map(|l| option(l)).collect(),
        multi_select: None,
        allow_custom_answer: None,
        initial_answer: None,
        required: None,
    }
}

#[tokio::test]
async fn a_bot_question_card_survives_a_restart_and_its_answer_wakes_the_bot() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "d-1", "fix the tests").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    let asked = t
        .host
        .request_ask(
            &me,
            goat2_host::api::RequestAskArgs {
                kind: goat2_host::api::AskKind::Question,
                summary: "How should I fix the tests?".into(),
                detail: None,
                options: Vec::new(),
                recommended: None,
                questions: vec![
                    question("scope", &["Unit tests (Recommended)", "E2E tests"]),
                    question(
                        "delivery",
                        &["One PR (Recommended)", "Separate PRs", "Just tell me"],
                    ),
                ],
                client_request_id: Some("plan-1".into()),
            },
        )
        .await;
    let request_id = match asked {
        SurfaceResult::NeedsHuman { handoff, .. } => handoff.handoff_id,
        other => panic!("{other:?}"),
    };
    assert!(request_id.starts_with("ask_"));
    let card = t.host.store().card(&id).unwrap();
    assert_eq!(
        card.needs_you.as_ref().map(|n| n.kind),
        Some(goat2_contracts::RequestKind::Question)
    );
    // The app quits while the bot's turn is still running.
    let t = reopen(t).await;
    let fold = t.host.store().fold(&id).unwrap();
    let open = fold
        .open_requests
        .iter()
        .find(|r| r.request_id.as_str() == request_id)
        .expect("the card survives the restart");
    let item = open
        .item_id
        .clone()
        .expect("the card points at its questions");
    let questions = t
        .host
        .store()
        .read_after(&id, 0)
        .unwrap()
        .into_iter()
        .find_map(|l| match l.event {
            LogEvent::ItemCompleted(done) if done.item.id == item => Some(done.item.body),
            _ => None,
        })
        .unwrap();
    assert!(
        matches!(questions, TurnItemBody::UserInputRequest { ref questions, .. } if questions.len() == 2)
    );
    let mut answers = serde_json::Map::new();
    answers.insert(
        "scope".into(),
        serde_json::json!("Unit tests (Recommended)"),
    );
    answers.insert("delivery".into(), serde_json::json!(["Separate PRs"]));
    t.host
        .command(ClientFrame::ResolveRequest {
            req_id: "r".into(),
            client_request_id: "answer-1".into(),
            thread_id: id.clone(),
            request_id: goat2_contracts::RequestId::new(request_id.clone()),
            outcome: goat2_contracts::RequestOutcome::Answered,
            text: None,
            answers: Some(answers),
            option_id: None,
        })
        .await
        .unwrap();
    eventually("the bot works on with the answer", || {
        t.fake.turn_texts(&id).iter().any(|text| {
            text.contains(
                "- Which scope?: Unit tests (Recommended)\n- Which delivery?: Separate PRs",
            )
        })
    })
    .await;
    assert!(t.host.store().card(&id).unwrap().needs_you.is_none());
}

#[tokio::test]
async fn a_bot_reads_and_changes_its_notes_through_mcp() {
    let t = setup().await;
    let (b, id) = bot(&t);
    say(&t, &id, "m-1", "remember that PRs are drafts").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    let change =
        |note: &str, replaces: Option<&str>, key: &str| goat2_host::api::BotNotesChangeArgs {
            note: note.into(),
            replaces: replaces.map(str::to_owned),
            client_request_id: Some(key.into()),
        };
    let saved = t
        .host
        .bot_notes_change(&me, change("Open PRs as drafts", None, "k1"))
        .await;
    assert!(
        matches!(&saved, SurfaceResult::Ok { value } if value["saved"] == true),
        "{saved:?}"
    );
    let again = t
        .host
        .bot_notes_change(&me, change("Open PRs as drafts", None, "k1"))
        .await;
    assert!(
        matches!(&again, SurfaceResult::Ok { value } if value["saved"] == false && value["reason"] == "already_saved")
    );
    let fixed = t
        .host
        .bot_notes_change(
            &me,
            change(
                "Open PRs ready for review",
                Some("Open PRs as drafts"),
                "k2",
            ),
        )
        .await;
    assert!(
        matches!(&fixed, SurfaceResult::Ok { value } if value["correction"] == "replaced"),
        "{fixed:?}"
    );
    let read = t
        .host
        .bot_notes_read(&me, goat2_host::api::BotNotesReadArgs { query: None })
        .await;
    let SurfaceResult::Ok { value } = read else {
        panic!("{read:?}")
    };
    let standing = value["standing"].as_str().unwrap();
    assert!(standing.contains("Open PRs ready for review"));
    assert!(!standing.contains(": Open PRs as drafts"));
    let file = std::fs::read_to_string(notes::notes_path(t.dir.path(), b.bot_id.as_str())).unwrap();
    assert!(file.starts_with(notes::NOTES_HEADER));
    assert_eq!(file.lines().filter(|l| l.starts_with("- ")).count(), 2);
}

#[tokio::test]
async fn fix_tests_acks_starts_a_briefed_worker_and_reports_the_result() {
    let t = setup().await;
    let (_, id) = bot(&t);
    say(&t, &id, "w-1", "fix the tests in this repo").await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(
            &t,
            &me,
            NotifyKind::Ack,
            "Starting a worker to fix the tests."
        )
        .await
        .is_ok()
    );
    let started = t
        .host
        .thread_start(
            &me,
            goat2_host::api::ThreadStartArgs {
                task: "Fix the failing tests in /tmp/repo".into(),
                ..Default::default()
            },
        )
        .await;
    let SurfaceResult::Ok { value } = started else {
        panic!("{started:?}")
    };
    let worker = ThreadId::new(value["started"]["childThreadId"].as_str().unwrap());
    t.fake
        .finish_turn(&id, "Starting a worker to fix the tests.");
    eventually("worker running", || running(&t, &worker)).await;
    // The right panel lists the bot's workers: a child card of the bot thread.
    let card = t.host.store().card(&worker).unwrap();
    assert_eq!(card.parent.as_ref().unwrap().thread_id, id);
    let brief = t.fake.turn_texts(&worker).remove(0);
    assert!(
        brief.starts_with("## Identity") || brief.starts_with("Fix the failing tests"),
        "{brief}"
    );
    assert!(brief.contains(
        "Fix the failing tests in /tmp/repo\n\n---\nThis work came in through GOAT from GOAT"
    ));
    assert!(brief.contains("goat_thread_report_result"));
    // The worker reports; the bot wakes with the result and tells the person.
    let wme = caller(&t, &worker).await;
    let reported = t
        .host
        .report_result(
            &wme,
            goat2_host::api::ReportResultArgs {
                outcome: goat2_host::api::ReportOutcome::Succeeded,
                summary: "3 tests fixed, all green".into(),
            },
        )
        .await;
    assert!(reported.is_ok());
    t.fake.finish_turn(&worker, "Fixed.");
    eventually("bot woken", || {
        t.fake
            .turn_texts(&id)
            .iter()
            .any(|x| x.contains("3 tests fixed, all green"))
    })
    .await;
    eventually("bot running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    assert!(
        send_to_user(
            &t,
            &me,
            NotifyKind::Result,
            "The tests are fixed: 3 were failing, all green now."
        )
        .await
        .is_ok()
    );
    t.fake
        .finish_turn(&id, "The tests are fixed: 3 were failing, all green now.");
    eventually("idle", || !running(&t, &id)).await;
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let sent: Vec<(NotifyKind, String)> = notified(&t, &id)
        .into_iter()
        .map(|n| (n.kind, n.text))
        .collect();
    assert_eq!(
        sent,
        vec![
            (
                NotifyKind::Ack,
                "Starting a worker to fix the tests.".to_owned()
            ),
            (
                NotifyKind::Result,
                "The tests are fixed: 3 were failing, all green now.".to_owned()
            ),
        ]
    );
}

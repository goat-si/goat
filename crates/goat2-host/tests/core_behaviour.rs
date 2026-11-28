//! Host core behaviour on the fake engine: caps, follow-up modes, Stop, child wake, restart
//! settlement, MCP caller rules, memory limit, command dedupe.

use std::sync::Arc;
use std::time::{Duration, Instant};

use goat2_contracts::{
    BotRole, ChildResultStatus, ClientFrame, DeliveredAs, DeliveryOutcome, InputMode, InputSource,
    LogEvent, ModelSelection, RequestKind, RequestOutcome, RunOutcome, StartMode, ThreadId,
    ThreadKind,
};
use goat2_host::api::{Caller, McpHost, SurfaceResult, ThreadStartArgs, UserSendArgs, WsHost};
use goat2_host::core::{Host, HostOptions};
use goat2_host::engine::fake::{FakeCall, FakeEngine, FakeScript};
use goat2_host::engine::{SteerResult, TurnStartResult};
use goat2_host::stall::StallRecorder;
use goat2_host::store::LaneAStore;

struct T {
    host: Host,
    fake: FakeEngine,
    _dir: Option<tempfile::TempDir>,
}

fn opts(dir: &std::path::Path, generation: u64) -> HostOptions {
    HostOptions {
        idle_stop: Duration::from_secs(30),
        collect_window: Duration::from_millis(150),
        child_coalesce: Duration::from_millis(150),
        memory_limit_bytes: 1_000,
        memory_sample: Duration::from_secs(3600),
        max_wait: Duration::from_secs(5),
        ..HostOptions::new(
            dir.to_path_buf(),
            generation,
            "ui-token".into(),
            "/tmp".into(),
        )
    }
}

async fn open_at(
    path: &std::path::Path,
    dir: Option<tempfile::TempDir>,
    fake: FakeEngine,
    generation: u64,
) -> T {
    let (store, report) = LaneAStore::open(path).unwrap();
    let settled: Vec<ThreadId> = report
        .settled
        .iter()
        .map(|s| ThreadId::new(s.thread_id.clone()))
        .collect();
    let store = Arc::new(store);
    let stall = StallRecorder::open(path).unwrap();
    let host = Host::open(opts(path, generation), store, Arc::new(fake.clone()), stall).unwrap();
    host.set_mcp_url("http://127.0.0.1:1/mcp".into());
    host.start(&settled).await.unwrap();
    T {
        host,
        fake,
        _dir: dir,
    }
}

async fn setup(script: FakeScript) -> T {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    open_at(&path, Some(dir), FakeEngine::new(script), 1).await
}

fn manual() -> FakeScript {
    FakeScript {
        auto_finish: false,
        ..FakeScript::default()
    }
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

fn events(t: &T, id: &ThreadId) -> Vec<LogEvent> {
    t.host
        .store()
        .read_after(id, 0)
        .unwrap()
        .into_iter()
        .map(|l| l.event)
        .collect()
}

fn count(t: &T, id: &ThreadId, tag: &str) -> usize {
    events(t, id).iter().filter(|e| e.type_tag() == tag).count()
}

fn selection() -> ModelSelection {
    ModelSelection {
        instance_id: "codex".into(),
        model: "test-model".into(),
        options: None,
    }
}

async fn start_user_thread(t: &T, key: &str, text: Option<&str>) -> ThreadId {
    let value = t
        .host
        .command(ClientFrame::StartThread {
            req_id: format!("r-{key}"),
            client_request_id: key.into(),
            kind: ThreadKind::User,
            title: Some(key.into()),
            bot_id: None,
            parent: None,
            model_selection: selection(),
            runtime_mode: None,
            cwd: Some("/tmp".into()),
            text: text.map(str::to_owned),
            mode: None,
        })
        .await
        .unwrap();
    value.thread_id.unwrap()
}

async fn send(
    t: &T,
    id: &ThreadId,
    key: &str,
    text: &str,
    mode: InputMode,
) -> goat2_contracts::CommandValue {
    t.host
        .command(ClientFrame::SendInput {
            req_id: format!("r-{key}"),
            client_request_id: key.into(),
            thread_id: id.clone(),
            text: text.into(),
            mode,
            attachments: None,
        })
        .await
        .unwrap()
}

fn main_bot(t: &T) -> ThreadId {
    t.host
        .bots()
        .into_iter()
        .find(|b| b.role == BotRole::Main)
        .unwrap()
        .session_thread_id
}

fn turns(t: &T, id: &ThreadId) -> Vec<Vec<String>> {
    t.fake
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            FakeCall::Turn {
                thread_id,
                input_ids,
                ..
            } if &thread_id == id => Some(input_ids),
            _ => None,
        })
        .collect()
}

fn running(t: &T, id: &ThreadId) -> bool {
    t.fake.active_turn(id).is_some()
}

/// The MCP caller for a thread's current process and run.
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
        .expect("engine started");
    let grant = t.host.grant(&token).expect("token valid");
    // The engine turn starts a moment before the host records the run as active.
    let start = Instant::now();
    loop {
        match t.host.caller(&grant).await {
            Ok(caller) => return caller,
            Err(err) if start.elapsed() < Duration::from_secs(5) => {
                let _ = err;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Err(err) => panic!("no active run: {err:?}"),
        }
    }
}

fn child_id(result: &SurfaceResult) -> ThreadId {
    let SurfaceResult::Ok { value } = result else {
        panic!("not ok: {result:?}")
    };
    ThreadId::new(value["started"]["childThreadId"].as_str().unwrap())
}

#[tokio::test]
async fn caps_limit_runs_to_four_and_starts_to_two() {
    let t = setup(FakeScript {
        auto_finish: false,
        start_ms: 60,
        ..FakeScript::default()
    })
    .await;
    let mut ids = Vec::new();
    for i in 0..6 {
        ids.push(start_user_thread(&t, &format!("cap-{i}"), Some("go")).await);
    }
    eventually("four runs", || {
        ids.iter().filter(|id| running(&t, id)).count() == 4
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        ids.iter().filter(|id| running(&t, id)).count(),
        4,
        "never more than 4 runs"
    );
    assert!(
        t.fake.max_concurrent_starts() <= 2,
        "starts: {}",
        t.fake.max_concurrent_starts()
    );
    let first = ids.iter().find(|id| running(&t, id)).unwrap().clone();
    t.fake.finish_turn(&first, "done");
    eventually("a waiting thread gets the slot", || {
        ids.iter().filter(|id| running(&t, id)).count() == 4 && turns(&t, &first).len() == 1
    })
    .await;
    assert_eq!(ids.iter().filter(|id| !turns(&t, id).is_empty()).count(), 5);
}

#[tokio::test]
async fn declined_steer_is_requeued_as_followup_with_the_same_input_id() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "steer", Some("first")).await;
    eventually("running", || running(&t, &id)).await;
    t.fake.push_steer_result(
        &id,
        SteerResult::Declined {
            reason: "busy".into(),
        },
    );
    let sent = send(&t, &id, "steer-2", "second", InputMode::Steer).await;
    let input_id = sent.input_id.unwrap();
    assert!(events(&t, &id).iter().any(|e| matches!(e,
        LogEvent::InputDelivered(d) if d.input_id == input_id && d.delivered_as == DeliveredAs::Steer && d.outcome == DeliveryOutcome::Declined)));
    t.fake.finish_turn(&id, "one");
    eventually("second turn", || turns(&t, &id).len() == 2).await;
    assert_eq!(turns(&t, &id)[1], vec![input_id.to_string()]);
    assert_eq!(
        count(&t, &id, "input.accepted"),
        2,
        "no new input for the requeue"
    );

    // An accepted steer joins the running turn.
    let sent = send(&t, &id, "steer-3", "third", InputMode::Steer).await;
    assert!(sent.run_id.is_some());
    assert!(t.fake.calls().iter().any(|c| matches!(c, FakeCall::Steer { input_ids, .. } if input_ids == &vec![sent.input_id.clone().unwrap().to_string()])));
}

#[tokio::test]
async fn refused_turn_start_fails_closed_and_holds_the_queue() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "refuse", None).await;
    t.fake.push_turn_result(
        &id,
        TurnStartResult::RefusedUnowned {
            reason: "native turn not owned".into(),
        },
    );
    send(&t, &id, "refuse-1", "hello", InputMode::Steer).await;
    eventually("run failed", || count(&t, &id, "run.finished") == 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(turns(&t, &id).is_empty(), "nothing was sent again");
    assert!(
        events(&t, &id)
            .iter()
            .any(|e| matches!(e, LogEvent::RunFinished(f) if f.outcome == RunOutcome::Failed))
    );
}

#[tokio::test]
async fn interrupt_goes_first_and_collect_merges() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "int", Some("long job")).await;
    eventually("running", || running(&t, &id)).await;
    let queued = send(&t, &id, "int-f", "later", InputMode::Followup)
        .await
        .input_id
        .unwrap();
    let urgent = send(&t, &id, "int-i", "now!", InputMode::Interrupt)
        .await
        .input_id
        .unwrap();
    eventually("interrupt turn", || turns(&t, &id).len() == 2).await;
    assert_eq!(turns(&t, &id)[1], vec![urgent.to_string()]);
    assert!(
        events(&t, &id)
            .iter()
            .any(|e| matches!(e, LogEvent::RunFinished(f) if f.outcome == RunOutcome::Interrupted))
    );
    t.fake.finish_turn(&id, "ok");
    eventually("followup turn", || turns(&t, &id).len() == 3).await;
    assert_eq!(turns(&t, &id)[2], vec![queued.to_string()]);
    t.fake.finish_turn(&id, "ok");
    eventually("idle", || !running(&t, &id)).await;
    let a = send(&t, &id, "col-a", "a", InputMode::Collect)
        .await
        .input_id
        .unwrap();
    let b = send(&t, &id, "col-b", "b", InputMode::Collect)
        .await
        .input_id
        .unwrap();
    eventually("collect turn", || turns(&t, &id).len() == 4).await;
    assert_eq!(turns(&t, &id)[3], vec![a.to_string(), b.to_string()]);
}

#[tokio::test]
async fn child_cap_depth_and_child_wake_order() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "bot-1", "do things", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let mut children = Vec::new();
    for i in 0..4 {
        let r = t
            .host
            .thread_start(
                &me,
                ThreadStartArgs {
                    task: format!("task {i}"),
                    ..Default::default()
                },
            )
            .await;
        children.push(child_id(&r));
    }
    let fifth = t
        .host
        .thread_start(
            &me,
            ThreadStartArgs {
                task: "task 5".into(),
                ..Default::default()
            },
        )
        .await;
    match fifth {
        SurfaceResult::Error { error } => {
            assert_eq!(error.reason, "child_budget");
            assert!(error.retryable);
        }
        other => panic!("expected child_budget, got {other:?}"),
    }
    // The bot holds one of the 4 run slots, so 3 children run now.
    eventually("three children running", || {
        children.iter().filter(|c| running(&t, c)).count() == 3
    })
    .await;
    let busy = children.iter().find(|c| running(&t, c)).unwrap().clone();
    let worker = caller(&t, &busy).await;
    assert_eq!(worker.kind, ThreadKind::Worker);
    match t
        .host
        .thread_start(
            &worker,
            ThreadStartArgs {
                task: "grandchild".into(),
                ..Default::default()
            },
        )
        .await
    {
        SurfaceResult::Error { error } => assert_eq!(error.reason, "depth_limit"),
        other => panic!("expected depth_limit, got {other:?}"),
    }
    // Bot run ends; two children finish close together -> one coalesced wake.
    t.fake.finish_turn(&bot, "started them");
    eventually("all four children running", || {
        children.iter().all(|c| running(&t, c))
    })
    .await;
    t.fake.finish_turn(&children[0], "result zero");
    t.fake.finish_turn(&children[1], "result one");
    eventually("bot woken", || turns(&t, &bot).len() == 2).await;
    assert_eq!(turns(&t, &bot)[1].len(), 2, "both results in one run");
    let ev = events(&t, &bot);
    let first_report = ev
        .iter()
        .position(|e| matches!(e, LogEvent::ChildReported(_)))
        .unwrap();
    let first_child_input = ev
        .iter()
        .position(|e| matches!(e, LogEvent::InputAccepted(i) if matches!(i.from, InputSource::Child { .. })))
        .unwrap();
    assert!(
        first_report < first_child_input,
        "child.reported is written before the wake input"
    );
    assert!(ev.iter().any(|e| matches!(e, LogEvent::ChildReported(r) if r.summary == "result zero" && r.status == ChildResultStatus::Completed)));
}

#[tokio::test]
async fn stop_holds_queue_stops_wait_children_and_keeps_async_children() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "s-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let async_child = child_id(
        &t.host
            .thread_start(
                &me,
                ThreadStartArgs {
                    task: "async".into(),
                    ..Default::default()
                },
            )
            .await,
    );
    let host = t.host.clone();
    let me2 = me.clone();
    let wait_call = tokio::spawn(async move {
        host.thread_start(
            &me2,
            ThreadStartArgs {
                task: "wait".into(),
                mode: Some(StartMode::Wait),
                ..Default::default()
            },
        )
        .await
    });
    eventually("two children", || {
        t.host
            .store()
            .cards()
            .iter()
            .filter(|c| c.kind == ThreadKind::Worker)
            .count()
            == 2
    })
    .await;
    let wait_child = t
        .host
        .store()
        .cards()
        .into_iter()
        .find(|c| c.kind == ThreadKind::Worker && c.id != async_child)
        .unwrap()
        .id;
    eventually("children running", || {
        running(&t, &async_child) && running(&t, &wait_child)
    })
    .await;
    let queued = send(&t, &bot, "s-2", "queued meanwhile", InputMode::Followup)
        .await
        .input_id
        .unwrap();
    t.host
        .command(ClientFrame::StopThread {
            req_id: "r".into(),
            client_request_id: "stop-1".into(),
            thread_id: bot.clone(),
        })
        .await
        .unwrap();
    eventually("bot stopped", || !running(&t, &bot)).await;
    eventually("wait child stopped", || !running(&t, &wait_child)).await;
    assert!(running(&t, &async_child), "async child keeps running");
    let released = wait_call.await.unwrap();
    assert!(
        matches!(&released, SurfaceResult::Ok { value } if value["released"] == "cancelled"),
        "{released:?}"
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(turns(&t, &bot).len(), 1, "queue held after Stop");
    t.host
        .command(ClientFrame::ResumeQueue {
            req_id: "r".into(),
            client_request_id: "resume-1".into(),
            thread_id: bot.clone(),
        })
        .await
        .unwrap();
    eventually("queue resumed", || turns(&t, &bot).len() == 2).await;
    assert!(turns(&t, &bot)[1].contains(&queued.to_string()));
}

#[tokio::test]
async fn wait_mode_returns_the_result_without_an_extra_parent_input() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "w-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let host = t.host.clone();
    let call = tokio::spawn(async move {
        host.thread_start(
            &me,
            ThreadStartArgs {
                task: "quick".into(),
                mode: Some(StartMode::Wait),
                ..Default::default()
            },
        )
        .await
    });
    eventually("child exists", || {
        t.host
            .store()
            .cards()
            .iter()
            .any(|c| c.kind == ThreadKind::Worker)
    })
    .await;
    let child = t
        .host
        .store()
        .cards()
        .into_iter()
        .find(|c| c.kind == ThreadKind::Worker)
        .unwrap()
        .id;
    eventually("child running", || running(&t, &child)).await;
    t.fake.finish_turn(&child, "the answer");
    let result = call.await.unwrap();
    assert!(
        matches!(&result, SurfaceResult::Ok { value } if value["result"]["summary"] == "the answer"),
        "{result:?}"
    );
    eventually("reported", || count(&t, &bot, "child.reported") == 1).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!events(&t, &bot).iter().any(
        |e| matches!(e, LogEvent::InputAccepted(i) if matches!(i.from, InputSource::Child { .. }))
    ));
}

#[tokio::test]
async fn mcp_caller_needs_an_active_run_and_a_current_process() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "mcp", Some("hi")).await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    let token = t
        .fake
        .calls()
        .into_iter()
        .find_map(|c| match c {
            FakeCall::Start { mcp_token, .. } => Some(mcp_token),
            _ => None,
        })
        .unwrap();
    assert!(
        t.host
            .user_send(
                &me,
                UserSendArgs {
                    kind: goat2_contracts::NotifyKind::Ack,
                    text: "on it".into()
                }
            )
            .await
            .is_ok()
    );
    let again = t
        .host
        .user_send(
            &me,
            UserSendArgs {
                kind: goat2_contracts::NotifyKind::Ack,
                text: "again".into(),
            },
        )
        .await;
    assert!(matches!(again, SurfaceResult::Error { ref error } if error.reason == "already_sent"));
    t.fake.finish_turn(&id, "bye");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    let grant = t.host.grant(&token).unwrap();
    let refused = t.host.caller(&grant).await.unwrap_err();
    assert_eq!(refused.reason, "no_active_run");
    // Crash -> token revoked.
    t.fake.crash(&id, "boom");
    eventually("revoked", || t.host.grant(&token).is_none()).await;
}

#[tokio::test]
async fn memory_limit_kills_only_that_thread_and_fails_the_run() {
    let t = setup(manual()).await;
    let a = start_user_thread(&t, "mem-a", Some("big")).await;
    let b = start_user_thread(&t, "mem-b", Some("small")).await;
    eventually("both running", || running(&t, &a) && running(&t, &b)).await;
    t.fake.set_rss(&a, 5_000);
    t.fake.set_rss(&b, 100);
    t.host.sample_memory();
    eventually("a failed", || events(&t, &a).iter().any(|e| matches!(e, LogEvent::RunFinished(f) if f.reason.as_deref() == Some("memory_limit") && f.outcome == RunOutcome::Failed))).await;
    assert!(
        t.fake
            .calls()
            .iter()
            .any(|c| matches!(c, FakeCall::Shutdown { thread_id } if thread_id == &a))
    );
    assert!(running(&t, &b));
    assert_eq!(
        t.host.store().card(&a).unwrap().status,
        goat2_contracts::ThreadStatus::Failed
    );
}

#[tokio::test]
async fn commands_are_deduped_by_client_request_id() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "dd", None).await;
    let first = send(&t, &id, "dd-1", "hello", InputMode::Followup).await;
    let again = send(&t, &id, "dd-1", "hello", InputMode::Followup).await;
    assert_eq!(again.input_id, first.input_id);
    assert_eq!(again.deduped, Some(true));
    assert_eq!(count(&t, &id, "input.accepted"), 1);
    let conflict = t
        .host
        .command(ClientFrame::SendInput {
            req_id: "x".into(),
            client_request_id: "dd-1".into(),
            thread_id: id.clone(),
            text: "different".into(),
            mode: InputMode::Followup,
            attachments: None,
        })
        .await
        .unwrap_err();
    assert_eq!(conflict.reason, "idempotency_conflict");
}

#[tokio::test]
async fn queue_edit_cancel_reorder_and_promote() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "q", Some("busy")).await;
    eventually("running", || running(&t, &id)).await;
    let a = send(&t, &id, "q-a", "a", InputMode::Followup)
        .await
        .input_id
        .unwrap();
    let b = send(&t, &id, "q-b", "b", InputMode::Followup)
        .await
        .input_id
        .unwrap();
    let c = send(&t, &id, "q-c", "c", InputMode::Followup)
        .await
        .input_id
        .unwrap();
    let cmd = |frame| t.host.command(frame);
    cmd(ClientFrame::EditQueued {
        req_id: "1".into(),
        client_request_id: "e1".into(),
        thread_id: id.clone(),
        input_id: a.clone(),
        text: "a2".into(),
    })
    .await
    .unwrap();
    cmd(ClientFrame::CancelQueued {
        req_id: "2".into(),
        client_request_id: "e2".into(),
        thread_id: id.clone(),
        input_id: b.clone(),
    })
    .await
    .unwrap();
    cmd(ClientFrame::ReorderQueued {
        req_id: "3".into(),
        client_request_id: "e3".into(),
        thread_id: id.clone(),
        input_ids: vec![c.clone(), a.clone()],
    })
    .await
    .unwrap();
    let fold = t.host.store().fold(&id).unwrap();
    let order: Vec<_> = fold
        .queued_inputs
        .iter()
        .map(|q| (q.input_id.clone(), q.text.clone()))
        .collect();
    assert_eq!(
        order,
        vec![(c.clone(), "c".to_owned()), (a.clone(), "a2".to_owned())]
    );
    let missing = cmd(ClientFrame::CancelQueued {
        req_id: "4".into(),
        client_request_id: "e4".into(),
        thread_id: id.clone(),
        input_id: b.clone(),
    })
    .await
    .unwrap_err();
    assert_eq!(missing.reason, "not_queued");
    cmd(ClientFrame::PromoteToSteer {
        req_id: "5".into(),
        client_request_id: "e5".into(),
        thread_id: id.clone(),
        input_id: c.clone(),
    })
    .await
    .unwrap();
    assert!(t.fake.calls().iter().any(|call| matches!(call, FakeCall::Steer { input_ids, .. } if input_ids == &vec![c.to_string()])));
    assert!(
        t.host
            .store()
            .fold(&id)
            .unwrap()
            .queued_inputs
            .iter()
            .all(|q| q.input_id != c)
    );
}

#[tokio::test]
async fn restart_settles_runs_and_wakes_parents() {
    let keep = tempfile::tempdir().unwrap();
    let path = keep.path().to_path_buf();
    // First host generation on its own runtime: dropping the runtime drops the host and the
    // store, which releases the data folder lock (lane A store.lock).
    let phase1_path = path.clone();
    let (unknown_thread, accepted_thread, bot, child, held_input) = std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(async move {
            let path = phase1_path;
            let t = open_at(&path, None, FakeEngine::new(manual()), 1).await;
            let bot = main_bot(&t);
            // A run that reached the engine.
            let accepted_thread = start_user_thread(&t, "acc", Some("x")).await;
            eventually("running", || running(&t, &accepted_thread)).await;
            // A run that never got an answer: the fake hangs before answering turn/start.
            let unknown_thread = start_user_thread(&t, "unk", None).await;
            // A bot with a running child.
            send(&t, &bot, "b", "go", InputMode::Followup).await;
            eventually("bot running", || running(&t, &bot)).await;
            let me = caller(&t, &bot).await;
            let child = child_id(
                &t.host
                    .thread_start(
                        &me,
                        ThreadStartArgs {
                            task: "child".into(),
                            ..Default::default()
                        },
                    )
                    .await,
            );
            eventually("child running", || running(&t, &child)).await;
            t.fake.finish_turn(&bot, "ok");
            eventually("bot idle", || !running(&t, &bot)).await;
            // Simulate a crash between run.started and the engine's answer.
            let store = t.host.store().clone();
            let accepted = store
                .append(
                    &unknown_thread,
                    vec![LogEvent::InputAccepted(goat2_contracts::InputAccepted {
                        input_id: "in_held".into(),
                        from: InputSource::User,
                        mode: InputMode::Followup,
                        text: "maybe sent".into(),
                        attachments: vec![],
                        client_request_id: "held-1".into(),
                    })],
                )
                .unwrap();
            assert_eq!(accepted.fold.queued_inputs.len(), 1);
            store
                .append(
                    &unknown_thread,
                    vec![LogEvent::RunStarted(goat2_contracts::RunStarted {
                        run_id: "run_lost".into(),
                        input_ids: vec!["in_held".into()],
                        generation: 1,
                        engine_ref: None,
                    })],
                )
                .unwrap();
            let held_input = goat2_contracts::InputId::new("in_held");
            t.host.shutdown().await;
            (unknown_thread, accepted_thread, bot, child, held_input)
        });
        drop(rt);
        out
    })
    .join()
    .unwrap();
    // Next host generation on the same folder.
    let t = {
        let (store, report) = LaneAStore::open(&path).unwrap();
        let settled: Vec<ThreadId> = report
            .settled
            .iter()
            .map(|s| ThreadId::new(s.thread_id.clone()))
            .collect();
        let store = Arc::new(store);
        let stall = StallRecorder::open(&path).unwrap();
        let fake = FakeEngine::new(manual());
        let host = Host::open(opts(&path, 2), store, Arc::new(fake.clone()), stall).unwrap();
        host.set_mcp_url("http://127.0.0.1:1/mcp".into());
        host.start(&settled).await.unwrap();
        (host, fake)
    };
    let (host, fake) = t;
    let ev = |id: &ThreadId| -> Vec<LogEvent> {
        host.store()
            .read_after(id, 0)
            .unwrap()
            .into_iter()
            .map(|l| l.event)
            .collect()
    };
    assert!(
        ev(&accepted_thread)
            .iter()
            .any(|e| matches!(e, LogEvent::RunFinished(f) if f.outcome == RunOutcome::Interrupted))
    );
    assert!(
        ev(&unknown_thread)
            .iter()
            .any(|e| matches!(e, LogEvent::RunFinished(f) if f.outcome == RunOutcome::Unknown))
    );
    let fold = host.store().fold(&unknown_thread).unwrap();
    assert_eq!(fold.held_inputs.len(), 1);
    assert!(
        fold.open_requests
            .iter()
            .any(|r| r.kind == RequestKind::Resend)
    );
    assert_eq!(
        host.store().card(&unknown_thread).unwrap().status,
        goat2_contracts::ThreadStatus::NeedsYou
    );
    // The child that ran at restart wakes the bot.
    let start = Instant::now();
    loop {
        let bot_ev = ev(&bot);
        if bot_ev.iter().any(|e| matches!(e, LogEvent::ChildReported(r) if r.child_thread_id == child && r.status == ChildResultStatus::InterruptedByRestart))
            && bot_ev.iter().any(|e| matches!(e, LogEvent::InputAccepted(i) if matches!(&i.from, InputSource::Child { thread_id } if thread_id == &child)))
        {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "bot not woken: {bot_ev:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Nothing is re-sent automatically for the unknown run; resend sends the same input.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !fake
            .calls()
            .iter()
            .any(|c| matches!(c, FakeCall::Turn { thread_id, .. } if thread_id == &unknown_thread))
    );
    let request_id = fold
        .open_requests
        .iter()
        .find(|r| r.kind == RequestKind::Resend)
        .unwrap()
        .request_id
        .clone();
    host.command(ClientFrame::ResolveRequest {
        req_id: "r".into(),
        client_request_id: "resend-1".into(),
        thread_id: unknown_thread.clone(),
        request_id,
        outcome: RequestOutcome::Resend,
        text: None,
        answers: None,
        option_id: None,
    })
    .await
    .unwrap();
    let start = Instant::now();
    while !fake.calls().iter().any(|c| matches!(c, FakeCall::Turn { thread_id, input_ids, .. } if thread_id == &unknown_thread && input_ids == &vec![held_input.to_string()])) {
        assert!(start.elapsed() < Duration::from_secs(5), "resend not sent");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// ---------------------------------------------------------------- review round 1 regressions

#[tokio::test]
async fn stop_cancels_a_wait_child_that_has_not_started_yet() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "pre-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    // Child processes now take a while to start.
    t.fake.set_script(FakeScript {
        auto_finish: false,
        start_ms: 300,
        ..FakeScript::default()
    });
    let host = t.host.clone();
    let call = tokio::spawn(async move {
        host.thread_start(
            &me,
            ThreadStartArgs {
                task: "slow".into(),
                mode: Some(StartMode::Wait),
                ..Default::default()
            },
        )
        .await
    });
    eventually("child exists", || {
        t.host
            .store()
            .cards()
            .iter()
            .any(|c| c.kind == ThreadKind::Worker)
    })
    .await;
    let child = t
        .host
        .store()
        .cards()
        .into_iter()
        .find(|c| c.kind == ThreadKind::Worker)
        .unwrap()
        .id;
    t.host
        .command(ClientFrame::StopThread {
            req_id: "r".into(),
            client_request_id: "stop-pre".into(),
            thread_id: bot.clone(),
        })
        .await
        .unwrap();
    let _ = call.await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        turns(&t, &child).is_empty(),
        "a stopped child must not start its turn later"
    );
    assert!(!running(&t, &child));
}

#[tokio::test]
async fn parallel_child_starts_cannot_pass_the_cap() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "par-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let calls: Vec<_> = (0..8)
        .map(|i| {
            let (host, me) = (t.host.clone(), me.clone());
            tokio::spawn(async move {
                host.thread_start(
                    &me,
                    ThreadStartArgs {
                        task: format!("t{i}"),
                        ..Default::default()
                    },
                )
                .await
            })
        })
        .collect();
    let mut ok = 0;
    let mut budget = 0;
    for call in calls {
        match call.await.unwrap() {
            SurfaceResult::Ok { .. } => ok += 1,
            SurfaceResult::Error { error } if error.reason == "child_budget" => budget += 1,
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!((ok, budget), (4, 4));
}

#[tokio::test]
async fn four_parents_waiting_on_children_do_not_starve_them() {
    let t = setup(manual()).await;
    let mut parents = Vec::new();
    for i in 0..4 {
        parents.push(start_user_thread(&t, &format!("park-{i}"), Some("go")).await);
    }
    eventually("four parents running", || {
        parents.iter().all(|p| running(&t, p))
    })
    .await;
    let mut calls = Vec::new();
    for p in &parents {
        let me = caller(&t, p).await;
        let host = t.host.clone();
        calls.push(tokio::spawn(async move {
            host.thread_start(
                &me,
                ThreadStartArgs {
                    task: "child".into(),
                    mode: Some(StartMode::Wait),
                    ..Default::default()
                },
            )
            .await
        }));
    }
    eventually("four children running", || {
        t.host
            .store()
            .cards()
            .iter()
            .filter(|c| c.kind == ThreadKind::Worker && running(&t, &c.id))
            .count()
            == 4
    })
    .await;
    for c in t
        .host
        .store()
        .cards()
        .into_iter()
        .filter(|c| c.kind == ThreadKind::Worker)
    {
        t.fake.finish_turn(&c.id, "done");
    }
    for call in calls {
        let result = call.await.unwrap();
        assert!(
            matches!(&result, SurfaceResult::Ok { value } if value["released"] == "completed"),
            "{result:?}"
        );
    }
}

#[tokio::test]
async fn refused_steer_fails_closed_and_unknown_steer_asks_a_person() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "sr", Some("first")).await;
    eventually("running", || running(&t, &id)).await;
    t.fake.push_steer_result(
        &id,
        SteerResult::RefusedUnowned {
            reason: "not ours".into(),
        },
    );
    let refused = t
        .host
        .command(ClientFrame::SendInput {
            req_id: "r".into(),
            client_request_id: "sr-1".into(),
            thread_id: id.clone(),
            text: "x".into(),
            mode: InputMode::Steer,
            attachments: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.reason, "steer_refused");
    assert!(
        t.host.store().fold(&id).unwrap().queued_inputs.is_empty(),
        "refused input left the queue"
    );
    t.fake.push_steer_result(
        &id,
        SteerResult::Unknown {
            reason: "timeout".into(),
        },
    );
    send(&t, &id, "sr-2", "maybe", InputMode::Steer).await;
    let fold = t.host.store().fold(&id).unwrap();
    assert_eq!(fold.held_inputs.len(), 1);
    assert!(
        fold.open_requests
            .iter()
            .any(|r| r.kind == RequestKind::Resend),
        "a person decides"
    );
}

#[tokio::test]
async fn child_report_and_wake_input_are_written_together() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "tog-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let child = child_id(
        &t.host
            .thread_start(
                &me,
                ThreadStartArgs {
                    task: "c".into(),
                    ..Default::default()
                },
            )
            .await,
    );
    t.fake.finish_turn(&bot, "ok");
    eventually("child running", || running(&t, &child)).await;
    t.fake.finish_turn(&child, "result");
    eventually("wake", || count(&t, &bot, "child.reported") == 1).await;
    let lines = t.host.store().read_after(&bot, 0).unwrap();
    let report = lines
        .iter()
        .position(|l| matches!(l.event, LogEvent::ChildReported(_)))
        .unwrap();
    assert!(
        matches!(&lines[report + 1].event, LogEvent::InputAccepted(i) if matches!(i.from, InputSource::Child { .. }))
    );
}

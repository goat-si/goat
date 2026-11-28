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
    // A collect window long enough that both collect inputs land in it on a loaded machine.
    let t = setup_with(manual(), |o| o.collect_window = Duration::from_secs(1)).await;
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

// ---------------------------------------------------------------- final review round regressions

/// Run the first host generation on its own runtime; dropping it releases the store lock.
fn first_generation<R: Send + 'static>(
    path: std::path::PathBuf,
    f: impl FnOnce(T) -> std::pin::Pin<Box<dyn std::future::Future<Output = R> + Send>> + Send + 'static,
) -> R {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt.block_on(async move {
            let t = open_at(&path, None, FakeEngine::new(manual()), 1).await;
            f(t).await
        });
        drop(rt);
        out
    })
    .join()
    .unwrap()
}

#[tokio::test]
async fn a_wait_result_lost_in_a_crash_wakes_the_parent_after_restart() {
    let keep = tempfile::tempdir().unwrap();
    let path = keep.path().to_path_buf();
    let (bot, child) = first_generation(path.clone(), |t| {
        Box::pin(async move {
            let bot = main_bot(&t);
            send(&t, &bot, "lw-1", "work", InputMode::Followup).await;
            eventually("bot running", || running(&t, &bot)).await;
            let me = caller(&t, &bot).await;
            let host = t.host.clone();
            let call = tokio::spawn(async move {
                host.thread_start(
                    &me,
                    ThreadStartArgs {
                        task: "c".into(),
                        mode: Some(StartMode::Wait),
                        ..Default::default()
                    },
                )
                .await
            });
            eventually("child", || {
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
            t.fake.finish_turn(&child, "the result");
            // The wait got it; the parent run is still active when the process "crashes".
            let _ = call.await.unwrap();
            eventually("reported", || count(&t, &bot, "child.reported") == 1).await;
            (bot, child)
        })
    });
    let t = open_at(&path, None, FakeEngine::new(manual()), 2).await;
    eventually("parent woken with the lost result", || {
        events(&t, &bot).iter().any(|e| matches!(e,
            LogEvent::InputAccepted(i) if matches!(&i.from, InputSource::Child { thread_id } if thread_id == &child) && i.text.contains("the result")))
    })
    .await;
    drop(keep);
}

#[tokio::test]
async fn mcp_keys_survive_a_restart() {
    let keep = tempfile::tempdir().unwrap();
    let path = keep.path().to_path_buf();
    let (bot, first_child, first_input) = first_generation(path.clone(), |t| {
        Box::pin(async move {
            let bot = main_bot(&t);
            send(&t, &bot, "mk-1", "work", InputMode::Followup).await;
            eventually("bot running", || running(&t, &bot)).await;
            let me = caller(&t, &bot).await;
            let child = child_id(
                &t.host
                    .thread_start(
                        &me,
                        ThreadStartArgs {
                            task: "c".into(),
                            client_request_id: Some("start-key".into()),
                            ..Default::default()
                        },
                    )
                    .await,
            );
            let sent = t
                .host
                .thread_send(
                    &me,
                    goat2_host::api::ThreadSendArgs {
                        thread_id: child.clone(),
                        text: "more".into(),
                        mode: None,
                        client_request_id: Some("send-key".into()),
                    },
                )
                .await;
            let SurfaceResult::Ok { value } = sent else {
                panic!("{sent:?}")
            };
            (bot, child, value["inputId"].as_str().unwrap().to_owned())
        })
    });
    let t = open_at(&path, None, FakeEngine::new(manual()), 2).await;
    send(&t, &bot, "mk-2", "again", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    let again = t
        .host
        .thread_start(
            &me,
            ThreadStartArgs {
                task: "c".into(),
                client_request_id: Some("start-key".into()),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(child_id(&again), first_child, "same key, same child");
    assert_eq!(
        t.host
            .store()
            .cards()
            .iter()
            .filter(|c| c.kind == ThreadKind::Worker)
            .count(),
        1
    );
    let resent = t
        .host
        .thread_send(
            &me,
            goat2_host::api::ThreadSendArgs {
                thread_id: first_child.clone(),
                text: "more".into(),
                mode: None,
                client_request_id: Some("send-key".into()),
            },
        )
        .await;
    let SurfaceResult::Ok { value } = resent else {
        panic!("{resent:?}")
    };
    assert_eq!(value["inputId"], first_input.as_str());
    assert_eq!(value["deduplicated"], true);
    drop(keep);
}

// ---------------------------------------------------------------- final review round 3 regressions

#[tokio::test]
async fn a_keyed_retry_finishes_a_half_made_child() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "half-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    // An earlier attempt created the child and crashed before child.started and its first input.
    let child = ThreadId::new(format!(
        "thr_{}",
        goat2_host::util::stable_id(&[bot.as_str(), "thread.start", "half-key"])
    ));
    let parent_card = t.host.store().card(&bot).unwrap();
    t.host
        .store()
        .create(
            &child,
            goat2_contracts::ThreadCreated {
                kind: ThreadKind::Worker,
                title: "half".into(),
                project_id: None,
                bot_id: parent_card.bot_id.clone(),
                parent: Some(goat2_contracts::ParentRef {
                    thread_id: bot.clone(),
                    by_item_id: "mcp:old:thread.start:half-key".into(),
                }),
                engine: parent_card.engine.clone(),
                follow_up_mode: goat2_contracts::FollowUpMode::Steer,
            },
        )
        .unwrap();
    let retry = t
        .host
        .thread_start(
            &me,
            ThreadStartArgs {
                task: "the task".into(),
                client_request_id: Some("half-key".into()),
                ..Default::default()
            },
        )
        .await;
    let SurfaceResult::Ok { value } = &retry else {
        panic!("{retry:?}")
    };
    assert_eq!(
        value["completedSteps"],
        serde_json::json!(["child.started", "first input"])
    );
    assert!(
        events(&t, &bot)
            .iter()
            .any(|e| matches!(e, LogEvent::ChildStarted(c) if c.child_thread_id == child))
    );
    eventually("the child runs its task", || turns(&t, &child).len() == 1).await;
}

#[tokio::test]
async fn recovery_cut_short_by_a_crash_is_finished_by_the_next_start() {
    let keep = tempfile::tempdir().unwrap();
    let path = keep.path().to_path_buf();
    let (bot, child) = first_generation(path.clone(), |t| {
        Box::pin(async move {
            let bot = main_bot(&t);
            send(&t, &bot, "cs-1", "work", InputMode::Followup).await;
            eventually("bot running", || running(&t, &bot)).await;
            let me = caller(&t, &bot).await;
            let host = t.host.clone();
            let call = tokio::spawn(async move {
                host.thread_start(
                    &me,
                    ThreadStartArgs {
                        task: "c".into(),
                        mode: Some(StartMode::Wait),
                        ..Default::default()
                    },
                )
                .await
            });
            eventually("child", || {
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
            t.fake.finish_turn(&child, "kept result");
            let _ = call.await.unwrap();
            eventually("reported", || count(&t, &bot, "child.reported") == 1).await;
            (bot, child)
        })
    });
    // Second start: the store opens and settles the bot's run, then the host "crashes" before
    // its recovery writes the wake input.
    {
        let (store, report) = LaneAStore::open(&path).unwrap();
        assert!(report.settled.iter().any(|s| s.thread_id == bot.as_str()));
        drop(store);
    }
    // Third start: the bot is no longer "settled now", but its lost result still wakes it.
    let t = open_at(&path, None, FakeEngine::new(manual()), 3).await;
    eventually("parent woken with the lost result", || {
        events(&t, &bot).iter().any(|e| matches!(e,
            LogEvent::InputAccepted(i) if matches!(&i.from, InputSource::Child { thread_id } if thread_id == &child) && i.text.contains("kept result")))
    })
    .await;
    drop(keep);
}

#[tokio::test]
async fn keyed_send_is_found_past_the_recent_lines() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "far-1", "work", InputMode::Followup).await;
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
    let first = t
        .host
        .thread_send(
            &me,
            goat2_host::api::ThreadSendArgs {
                thread_id: child.clone(),
                text: "x".into(),
                mode: Some(InputMode::Followup),
                client_request_id: Some("far-key".into()),
            },
        )
        .await;
    let SurfaceResult::Ok { value: first } = first else {
        panic!("{first:?}")
    };
    for _ in 0..600 {
        t.host
            .store()
            .append(
                &child,
                vec![LogEvent::ThreadChanged(
                    goat2_contracts::ThreadChanged::default(),
                )],
            )
            .unwrap();
    }
    let again = t
        .host
        .thread_send(
            &me,
            goat2_host::api::ThreadSendArgs {
                thread_id: child.clone(),
                text: "x".into(),
                mode: Some(InputMode::Followup),
                client_request_id: Some("far-key".into()),
            },
        )
        .await;
    let SurfaceResult::Ok { value } = again else {
        panic!("{again:?}")
    };
    assert_eq!(value["inputId"], first["inputId"]);
    assert_eq!(value["deduplicated"], true);
}

// ---------------------------------------------------------------- final review round 4 regressions

#[tokio::test]
async fn recovery_tells_apart_two_results_of_the_same_child() {
    let keep = tempfile::tempdir().unwrap();
    let path = keep.path().to_path_buf();
    let (bot, child) = first_generation(path.clone(), |t| {
        Box::pin(async move {
            let bot = main_bot(&t);
            send(&t, &bot, "two-1", "work", InputMode::Followup).await;
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
            // Inside this parent run the child reported twice; only the second run's wake was
            // written before the crash.
            let cursor = goat2_contracts::ThreadCursor {
                epoch: t.host.store().card(&child).unwrap().epoch,
                seq: 1,
            };
            let reported = |run: &str, text: &str| {
                LogEvent::ChildReported(goat2_contracts::ChildReported {
                    child_thread_id: child.clone(),
                    child_run_id: Some(run.into()),
                    status: ChildResultStatus::Completed,
                    summary: text.into(),
                    child_cursor: cursor.clone(),
                })
            };
            t.host
                .store()
                .append(&bot, vec![reported("run_a", "first result")])
                .unwrap();
            t.host
                .store()
                .append(
                    &bot,
                    vec![
                        reported("run_b", "second result"),
                        LogEvent::InputAccepted(goat2_contracts::InputAccepted {
                            input_id: "in_wake_b".into(),
                            from: InputSource::Child {
                                thread_id: child.clone(),
                            },
                            mode: InputMode::Followup,
                            text: "second result".into(),
                            attachments: vec![],
                            client_request_id: format!("child:{child}:run_b"),
                        }),
                    ],
                )
                .unwrap();
            (bot, child)
        })
    });
    let t = open_at(&path, None, FakeEngine::new(manual()), 2).await;
    eventually("the first result wakes the parent too", || {
        events(&t, &bot).iter().any(|e| {
            matches!(e,
            LogEvent::InputAccepted(i) if i.client_request_id == format!("child:{child}:run_a"))
        })
    })
    .await;
    drop(keep);
}

#[tokio::test]
async fn a_keyed_wait_mode_retry_still_waits() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "wr-1", "work", InputMode::Followup).await;
    eventually("bot running", || running(&t, &bot)).await;
    let me = caller(&t, &bot).await;
    // First attempt: wait mode, its wait times out (the reply was lost to the agent).
    let first = t
        .host
        .thread_start(
            &me,
            ThreadStartArgs {
                task: "c".into(),
                mode: Some(StartMode::Wait),
                timeout_ms: Some(50),
                client_request_id: Some("wait-key".into()),
                ..Default::default()
            },
        )
        .await;
    let child = child_id(&first);
    eventually("child running", || running(&t, &child)).await;
    // Retry with the same key waits for the child's result again.
    let host = t.host.clone();
    let me2 = me.clone();
    let retry = tokio::spawn(async move {
        host.thread_start(
            &me2,
            ThreadStartArgs {
                task: "c".into(),
                mode: Some(StartMode::Wait),
                client_request_id: Some("wait-key".into()),
                ..Default::default()
            },
        )
        .await
    });
    eventually("the retry is waiting on the child", || {
        t.host.waiting_on(&child)
    })
    .await;
    assert!(!retry.is_finished(), "the retry waits");
    t.fake.finish_turn(&child, "done now");
    let result = retry.await.unwrap();
    let SurfaceResult::Ok { value } = &result else {
        panic!("{result:?}")
    };
    assert_eq!(value["deduplicated"], true);
    assert_eq!(value["wait"]["released"], "completed");
    assert_eq!(value["wait"]["result"]["summary"], "done now");
}

#[tokio::test]
async fn an_unreadable_log_refuses_a_keyed_write() {
    let t = setup(manual()).await;
    let bot = main_bot(&t);
    send(&t, &bot, "ul-1", "work", InputMode::Followup).await;
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
    let before = count(&t, &child, "input.accepted");
    // The child's log cannot be read: the host cannot tell whether the key was used.
    let log = t
        ._dir
        .as_ref()
        .unwrap()
        .path()
        .join("threads")
        .join(child.as_str())
        .join("goat.jsonl");
    let saved = std::fs::read(&log).unwrap();
    std::fs::remove_file(&log).unwrap();
    let sent = t
        .host
        .thread_send(
            &me,
            goat2_host::api::ThreadSendArgs {
                thread_id: child.clone(),
                text: "x".into(),
                mode: Some(InputMode::Followup),
                client_request_id: Some("ul-key".into()),
            },
        )
        .await;
    match &sent {
        SurfaceResult::Error { error } => {
            assert_eq!(error.reason, "log_unreadable");
            assert!(error.retryable);
        }
        other => panic!("expected log_unreadable, got {other:?}"),
    }
    std::fs::write(&log, saved).unwrap();
    assert_eq!(
        count(&t, &child, "input.accepted"),
        before,
        "nothing was written"
    );
}

type Snapshots = Arc<std::sync::Mutex<Vec<(u64, Vec<i32>)>>>;

#[tokio::test]
async fn the_newest_engine_group_snapshot_is_the_live_set() {
    let t = setup(FakeScript {
        auto_finish: false,
        start_ms: 5,
        ..FakeScript::default()
    })
    .await;
    let seen: Snapshots = Arc::default();
    {
        let seen = seen.clone();
        t.host.on_engine_groups(move |seq, mut groups| {
            groups.sort();
            seen.lock().unwrap().push((seq, groups));
        });
    }
    let mut ids = Vec::new();
    for i in 0..4 {
        let id = start_user_thread(&t, &format!("pg-{i}"), None).await;
        t.fake.set_pgid(&id, 70_000 + i);
        ids.push(id);
    }
    // All four engines start at about the same time.
    for (i, id) in ids.iter().enumerate() {
        send(&t, id, &format!("pg-go-{i}"), "go", InputMode::Followup).await;
    }
    eventually("four engines", || ids.iter().all(|id| running(&t, id))).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let seen = seen.lock().unwrap().clone();
    let newest = seen.iter().max_by_key(|(seq, _)| *seq).unwrap();
    assert_eq!(
        newest.1,
        vec![70_000, 70_001, 70_002, 70_003],
        "snapshots: {seen:?}"
    );
    // Seq numbers are unique and follow capture order.
    let mut seqs: Vec<u64> = seen.iter().map(|(s, _)| *s).collect();
    seqs.dedup();
    assert_eq!(seqs.len(), seen.len());
}

#[tokio::test]
async fn an_engine_sign_in_need_becomes_a_signin_request() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "auth", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    // A long link with a one-time code in its query, also repeated in the message.
    let url = format!(
        "https://auth.example.invalid/device?user_code=SECRET-CODE&pad={}",
        "p".repeat(600)
    );
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::AuthRequired {
            key: None,
            turn_id: t.fake.active_turn(&id),
            url: Some(url.clone()),
            message: format!("Sign in to Codex at {url}"),
        },
    );
    eventually("needs you: signin", || {
        t.host
            .store()
            .card(&id)
            .and_then(|c| c.needs_you)
            .is_some_and(|n| n.kind == RequestKind::Signin)
    })
    .await;
    let opened = signins(&t, &id);
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].summary, "Sign in to continue");
    assert_eq!(opened[0].run_id.as_ref(), last_run(&t, &id).as_ref());
    // The full link is held in memory for the providers module, never written to disk.
    let links = t.host.signin_links();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].url, url);
    assert_eq!(links[0].request_id, opened[0].request_id);
    assert!(!data_contains(&t, "SECRET-CODE"));
    t.host
        .command(ClientFrame::ResolveRequest {
            req_id: "r".into(),
            client_request_id: "auth-done".into(),
            thread_id: id.clone(),
            request_id: opened[0].request_id.clone(),
            outcome: RequestOutcome::Answered,
            text: Some("signed in".into()),
            answers: None,
            option_id: None,
        })
        .await
        .unwrap();
    assert!(t.host.store().fold(&id).unwrap().open_requests.is_empty());
    assert!(t.host.signin_links().is_empty());
}

#[tokio::test]
async fn a_sign_in_for_an_ended_turn_is_dropped_and_run_end_closes_the_current_one() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "auth-turns", Some("one")).await;
    eventually("first turn", || running(&t, &id)).await;
    let first = t.fake.active_turn(&id).unwrap();
    t.fake.finish_turn(&id, "done");
    eventually("first run finished", || count(&t, &id, "run.finished") == 1).await;
    send(&t, &id, "auth-two", "two", InputMode::Followup).await;
    eventually("second turn", || running(&t, &id)).await;
    let second = t.fake.active_turn(&id).unwrap();
    assert_ne!(first, second);
    let auth =
        |turn: &str, url: &str, message: &str| goat2_host::engine::EngineEvent::AuthRequired {
            key: None,
            turn_id: Some(turn.to_owned()),
            url: Some(url.to_owned()),
            message: message.to_owned(),
        };
    t.fake
        .emit(&id, auth(&first, "https://stale.invalid/login", "stale"));
    t.fake
        .emit(&id, auth(&second, "https://fresh.invalid/login", "fresh"));
    eventually("sign-in link", || !t.host.signin_links().is_empty()).await;
    let opened = signins(&t, &id);
    assert_eq!(
        opened.len(),
        1,
        "only the running turn's sign-in: {opened:?}"
    );
    assert_eq!(opened[0].summary, "Sign in to continue");
    assert_eq!(t.host.signin_links()[0].url, "https://fresh.invalid/login");
    assert_eq!(opened[0].run_id.as_ref(), last_run(&t, &id).as_ref());
    // A repeat in the same run refreshes the link without a second request.
    t.fake.emit(
        &id,
        auth(&second, "https://fresh.invalid/again", "fresh again"),
    );
    eventually("refreshed link", || {
        t.host.signin_links().first().map(|l| l.url.as_str()) == Some("https://fresh.invalid/again")
    })
    .await;
    assert_eq!(signins(&t, &id).len(), 1);
    t.fake.finish_turn(&id, "done");
    eventually("sign-in closed with the run", || {
        t.host.store().fold(&id).unwrap().open_requests.is_empty()
    })
    .await;
    assert_eq!(
        resolved_text(&t, &id, &opened[0].request_id),
        Some("the run ended".into())
    );
    assert!(t.host.signin_links().is_empty());
}

#[tokio::test]
async fn a_sign_in_outside_a_turn_lasts_until_the_engine_stops() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "auth-session", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::AuthRequired {
            key: None,
            turn_id: None,
            url: Some("https://auth.example.invalid/login?state=SECRET-STATE".into()),
            message: "Not logged in".into(),
        },
    );
    eventually("sign-in link", || !t.host.signin_links().is_empty()).await;
    let opened = signins(&t, &id);
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].run_id, None);
    // The run ending does not close it: it belongs to the engine session.
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    assert_eq!(t.host.store().fold(&id).unwrap().open_requests.len(), 1);
    t.fake.crash(&id, "gone");
    eventually("sign-in closed with the engine", || {
        t.host.store().fold(&id).unwrap().open_requests.is_empty()
    })
    .await;
    assert_eq!(
        resolved_text(&t, &id, &opened[0].request_id),
        Some("the engine stopped".into())
    );
    assert!(t.host.signin_links().is_empty());
    assert!(!data_contains(&t, "SECRET-STATE"));
}

#[tokio::test]
async fn a_sign_in_message_never_reaches_the_log() {
    // Secrets in forms a redaction would miss: a URL only in the message, a mailto: link, a
    // bracket inside a URL path, and a bare code.
    let messages = [
        "Open https://host.invalid/device/SECRET-PATH to sign in",
        "Mail mailto:auth@host.invalid?body=SECRET-MAIL to sign in",
        "Open https://host.invalid/a_(b)/SECRET-PAREN to sign in",
        "Enter code SECRET-CODE at the device page",
    ];
    for (n, message) in messages.into_iter().enumerate() {
        let t = setup(manual()).await;
        let id = start_user_thread(&t, &format!("auth-message-{n}"), Some("hello")).await;
        eventually("running", || running(&t, &id)).await;
        t.fake.emit(
            &id,
            goat2_host::engine::EngineEvent::AuthRequired {
                key: None,
                turn_id: t.fake.active_turn(&id),
                url: None,
                message: message.into(),
            },
        );
        eventually("needs you: signin", || signins(&t, &id).len() == 1).await;
        assert_eq!(signins(&t, &id)[0].summary, "Sign in to continue");
        assert!(t.host.signin_links().is_empty(), "no url field, no link");
        assert!(!data_contains(&t, "SECRET"), "{message}");
    }
}

#[tokio::test]
async fn part2_fields_carry_what_the_host_knows() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "p2-fields", Some("hi")).await;
    eventually("running", || running(&t, &id)).await;
    let me = caller(&t, &id).await;
    // request.ask's detail becomes the request's context, trimmed and bounded.
    let long = format!(
        "  {}  ",
        "d".repeat(goat2_contracts::limits::REQUEST_CONTEXT_MAX_CHARS + 50)
    );
    let asked = t
        .host
        .request_ask(
            &me,
            goat2_host::api::RequestAskArgs {
                kind: goat2_host::api::AskKind::Question,
                summary: "Which branch?".into(),
                detail: Some(long),
                options: Vec::new(),
                client_request_id: None,
            },
        )
        .await;
    assert!(
        matches!(asked, SurfaceResult::NeedsHuman { .. }),
        "{asked:?}"
    );
    let context = events(&t, &id)
        .into_iter()
        .find_map(|e| match e {
            LogEvent::RequestOpened(o) if o.summary == "Which branch?" => Some(o.context),
            _ => None,
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        context.chars().count(),
        goat2_contracts::limits::REQUEST_CONTEXT_MAX_CHARS
    );
    assert!(context.starts_with('d'));
    // user.send by the agent is recorded as written by its session.
    t.host
        .user_send(
            &me,
            UserSendArgs {
                kind: goat2_contracts::NotifyKind::Ack,
                text: "on it".into(),
            },
        )
        .await;
    assert!(events(&t, &id).iter().any(|e| matches!(
        e,
        LogEvent::UserNotified(n)
            if n.source == Some(goat2_contracts::NotificationSource::Session)
    )));
    // A Part 2 command whose module has not landed is refused as not available.
    let refused = t
        .host
        .command(ClientFrame::RefreshProviders {
            req_id: "r".into(),
            client_request_id: "p2-refresh".into(),
            instance_id: None,
            refresh_models: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.reason, "not_available");
    assert_eq!(
        refused.code,
        goat2_contracts::AgentSurfaceErrorCode::Unavailable
    );
}

#[tokio::test]
async fn a_late_item_goes_to_its_origin_run_and_never_to_another() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "late", Some("one")).await;
    eventually("first turn", || running(&t, &id)).await;
    let first = t.fake.active_turn(&id).unwrap();
    let run1 = last_run(&t, &id).unwrap();
    t.fake.finish_turn(&id, "first answer");
    eventually("first run finished", || count(&t, &id, "run.finished") == 1).await;
    send(&t, &id, "late-two", "two", InputMode::Followup).await;
    eventually("second turn", || running(&t, &id)).await;
    let run2 = last_run(&t, &id).unwrap();
    assert_ne!(run1, run2);
    // While run 2 runs: an item for an unknown turn is dropped, the first turn's late items go
    // to run 1 (a background subagent result and a late assistant message).
    let emit = |turn: &str, item: goat2_contracts::TurnItem| {
        t.fake.emit(
            &id,
            goat2_host::engine::EngineEvent::ItemCompleted {
                turn_id: turn.to_owned(),
                item: Box::new(item),
                locator: None,
            },
        )
    };
    emit("no-such-turn", late_text(&id, "stray", "stray"));
    emit(&first, subagent_item(&id, "sub-1", None));
    emit(
        &first,
        late_text(&id, "late-text", "late answer from run 1"),
    );
    eventually("late items", || item_run(&t, &id, "late-text").is_some()).await;
    assert_eq!(item_run(&t, &id, "sub-1"), Some(run1.clone()));
    assert_eq!(item_run(&t, &id, "late-text"), Some(run1.clone()));
    assert_eq!(item_run(&t, &id, "stray"), None);
    // Run 2 keeps its own answer.
    t.fake.finish_turn(&id, "second answer");
    eventually("second run finished", || {
        count(&t, &id, "run.finished") == 2
    })
    .await;
    let finished = events(&t, &id)
        .into_iter()
        .filter_map(|e| match e {
            LogEvent::RunFinished(f) => Some(f.run_id),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finished,
        vec![run1.clone(), run2.clone()],
        "no run reopened or finished twice"
    );
    // While idle: still filed on run 1.
    emit(&first, subagent_item(&id, "sub-2", None));
    eventually("idle late item", || item_run(&t, &id, "sub-2").is_some()).await;
    assert_eq!(item_run(&t, &id, "sub-2"), Some(run1));
    assert_eq!(count(&t, &id, "run.finished"), 2);
}

#[tokio::test]
async fn a_running_background_subagent_keeps_the_engine_from_idle_stopping() {
    let t = setup_with(manual(), |o| o.idle_stop = Duration::from_millis(150)).await;
    let id = start_user_thread(&t, "bg", Some("go")).await;
    eventually("running", || running(&t, &id)).await;
    let turn = t.fake.active_turn(&id).unwrap();
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::SubagentUpdate {
            turn_id: Some(turn.clone()),
            subagent_id: "bg-1".into(),
            status: goat2_contracts::TurnItemStatus::Running,
            title: None,
            progress: None,
        },
    );
    t.fake.finish_turn(&id, "done for now");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !shut_down(&t, &id),
        "not idle-stopped while the subagent runs"
    );
    // The subagent finishes late: its item lands on the run, then the idle stop follows.
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::ItemCompleted {
            turn_id: turn,
            item: Box::new(subagent_item(&id, "bg-1-item", Some("bg-1"))),
            locator: None,
        },
    );
    eventually("idle stop after the subagent", || shut_down(&t, &id)).await;
    assert!(item_run(&t, &id, "bg-1-item").is_some());
}

async fn setup_with(script: FakeScript, tweak: impl FnOnce(&mut HostOptions)) -> T {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let fake = FakeEngine::new(script);
    let (store, _) = LaneAStore::open(&path).unwrap();
    let mut options = opts(&path, 1);
    tweak(&mut options);
    let stall = StallRecorder::open(&path).unwrap();
    let host = Host::open(options, Arc::new(store), Arc::new(fake.clone()), stall).unwrap();
    host.set_mcp_url("http://127.0.0.1:1/mcp".into());
    host.start(&[]).await.unwrap();
    T {
        host,
        fake,
        _dir: Some(dir),
    }
}

fn shut_down(t: &T, id: &ThreadId) -> bool {
    t.fake
        .calls()
        .iter()
        .any(|c| matches!(c, FakeCall::Shutdown { thread_id } if thread_id == id))
}

fn item_run(t: &T, id: &ThreadId, item_id: &str) -> Option<goat2_contracts::RunId> {
    events(t, id).into_iter().find_map(|e| match e {
        LogEvent::ItemCompleted(i) if i.item.id.as_str() == item_id => Some(i.run_id),
        _ => None,
    })
}

fn late_text(id: &ThreadId, item_id: &str, text: &str) -> goat2_contracts::TurnItem {
    goat2_host::engine::fake::assistant_item(id, &item_id.into(), "late", text)
}

/// A finished engine-native subagent item (`subagent_id` defaults to the item id).
fn subagent_item(
    id: &ThreadId,
    item_id: &str,
    subagent_id: Option<&str>,
) -> goat2_contracts::TurnItem {
    let mut item = late_text(id, item_id, "");
    item.body = goat2_contracts::TurnItemBody::Subagent {
        subagent_id: subagent_id.unwrap_or(item_id).to_owned(),
        origin: goat2_contracts::SubagentOrigin::ProviderNative,
        driver: "claudeAgent".into(),
        provider_instance_id: "claudeAgent".into(),
        child_thread_id: None,
        prompt: "look around".into(),
        progress: None,
        result: Some("found it".into()),
    };
    item
}

#[tokio::test]
async fn a_steer_the_engine_cancels_is_requeued_as_a_followup() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "steer-cancel", Some("start")).await;
    eventually("running", || running(&t, &id)).await;
    let turn = t.fake.active_turn(&id).unwrap();
    send(&t, &id, "steer-cancel-more", "also this", InputMode::Steer).await;
    let steered = t
        .fake
        .calls()
        .into_iter()
        .find_map(|c| match c {
            FakeCall::Steer { input_ids, .. } => input_ids.first().cloned(),
            _ => None,
        })
        .expect("the steer reached the engine");
    let accepted_before = count(&t, &id, "input.accepted");
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::SteerUpdated {
            turn_id: turn,
            input_ids: vec![steered.as_str().into()],
            status: goat2_host::engine::SteerStatus::Cancelled {
                reason: "discarded".into(),
            },
        },
    );
    eventually("requeued", || {
        t.host
            .store()
            .fold(&id)
            .unwrap()
            .queued_inputs
            .iter()
            .any(|q| q.input_id.as_str() == steered && q.mode == InputMode::Followup)
    })
    .await;
    assert_eq!(
        count(&t, &id, "input.accepted"),
        accepted_before,
        "no second message"
    );
    // The next turn carries it.
    t.fake.finish_turn(&id, "done");
    eventually("next turn with the input", || {
        t.fake.calls().iter().any(|c| {
            matches!(
                c,
                FakeCall::Turn { input_ids, .. } if input_ids.contains(&steered)
            )
        })
    })
    .await;
}

#[tokio::test]
async fn a_turn_with_a_live_subagent_outlives_the_turn_cap() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "cap", Some("turn 1")).await;
    eventually("turn 1", || running(&t, &id)).await;
    let first = t.fake.active_turn(&id).unwrap();
    let run1 = last_run(&t, &id).unwrap();
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::SubagentUpdate {
            turn_id: Some(first.clone()),
            subagent_id: "long-1".into(),
            status: goat2_contracts::TurnItemStatus::Running,
            title: None,
            progress: None,
        },
    );
    let mut second = None;
    // 65 more turns: past the 64 turns the host remembers.
    for n in 1..=65usize {
        t.fake.finish_turn(&id, "ok");
        eventually("run finished", || count(&t, &id, "run.finished") == n).await;
        send(&t, &id, &format!("cap-{n}"), "next", InputMode::Followup).await;
        eventually("next turn", || running(&t, &id)).await;
        if n == 1 {
            second = t.fake.active_turn(&id);
        }
    }
    let emit = |turn: &str, item: goat2_contracts::TurnItem| {
        t.fake.emit(
            &id,
            goat2_host::engine::EngineEvent::ItemCompleted {
                turn_id: turn.to_owned(),
                item: Box::new(item),
                locator: None,
            },
        )
    };
    // Turn 2 had no live subagent, so it was forgotten: its late item is dropped. Turn 1's
    // subagent was still running, so its result lands on run 1.
    emit(&second.unwrap(), late_text(&id, "late-2", "too late"));
    emit(&first, subagent_item(&id, "long-1-item", Some("long-1")));
    eventually("subagent result", || {
        item_run(&t, &id, "long-1-item").is_some()
    })
    .await;
    assert_eq!(item_run(&t, &id, "long-1-item"), Some(run1));
    assert_eq!(item_run(&t, &id, "late-2"), None);
}

#[tokio::test]
async fn a_subagent_without_a_turn_keeps_its_origin_through_the_turn_cap() {
    // Reported without a turn while turn 1 runs: turn 1 is its origin.
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "cap-none", Some("turn 1")).await;
    eventually("turn 1", || running(&t, &id)).await;
    let first = t.fake.active_turn(&id).unwrap();
    let run1 = last_run(&t, &id).unwrap();
    t.fake.emit(
        &id,
        subagent_update(None, "anon-1", goat2_contracts::TurnItemStatus::Running),
    );
    more_turns(&t, &id, 0, 65).await;
    emit_item(
        &t,
        &id,
        &first,
        subagent_item(&id, "anon-1-item", Some("anon-1")),
    );
    eventually("subagent result", || {
        item_run(&t, &id, "anon-1-item").is_some()
    })
    .await;
    assert_eq!(item_run(&t, &id, "anon-1-item"), Some(run1));
}

#[tokio::test]
async fn a_subagent_of_unknown_origin_stops_eviction_until_it_ends() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "cap-unknown", Some("turn 1")).await;
    eventually("turn 1", || running(&t, &id)).await;
    t.fake.finish_turn(&id, "ok");
    eventually("idle", || count(&t, &id, "run.finished") == 1).await;
    // No turn running: its origin is unknown, so no turn may be forgotten while it lives.
    t.fake.emit(
        &id,
        subagent_update(None, "anon-2", goat2_contracts::TurnItemStatus::Running),
    );
    send(&t, &id, "cap-unknown-2", "turn 2", InputMode::Followup).await;
    eventually("turn 2", || running(&t, &id)).await;
    let (second, run2) = (t.fake.active_turn(&id).unwrap(), last_run(&t, &id).unwrap());
    let mut third = None;
    for n in 2..=65usize {
        t.fake.finish_turn(&id, "ok");
        eventually("run finished", || count(&t, &id, "run.finished") == n).await;
        send(
            &t,
            &id,
            &format!("cap-unknown-{}", n + 1),
            "next",
            InputMode::Followup,
        )
        .await;
        eventually("next turn", || running(&t, &id)).await;
        if n == 2 {
            third = t.fake.active_turn(&id);
        }
    }
    // 65 turns later turn 2 is still known.
    emit_item(&t, &id, &second, late_text(&id, "late-2", "still known"));
    eventually("turn 2 item", || item_run(&t, &id, "late-2").is_some()).await;
    assert_eq!(item_run(&t, &id, "late-2"), Some(run2));
    // Once it ends and its finished item is recorded, the next turn trims the record back under
    // the cap: turn 3 is forgotten.
    t.fake.emit(
        &id,
        subagent_update(None, "anon-2", goat2_contracts::TurnItemStatus::Completed),
    );
    emit_item(
        &t,
        &id,
        &second,
        subagent_item(&id, "anon-2-item", Some("anon-2")),
    );
    eventually("anon-2 item", || item_run(&t, &id, "anon-2-item").is_some()).await;
    more_turns(&t, &id, 65, 1).await;
    emit_item(
        &t,
        &id,
        &third.unwrap(),
        late_text(&id, "late-3", "forgotten"),
    );
    // Barrier: an item of the running turn, handled after the one above.
    let now = t.fake.active_turn(&id).unwrap();
    emit_item(&t, &id, &now, late_text(&id, "barrier", "current"));
    eventually("barrier", || item_run(&t, &id, "barrier").is_some()).await;
    assert_eq!(item_run(&t, &id, "late-3"), None);
}

/// Finish the running turn and start `n` more; `done` runs have finished before.
async fn more_turns(t: &T, id: &ThreadId, done: usize, n: usize) {
    for k in 1..=n {
        t.fake.finish_turn(id, "ok");
        eventually("run finished", || count(t, id, "run.finished") == done + k).await;
        send(
            t,
            id,
            &format!("more-{}-{}", id.as_str(), done + k),
            "next",
            InputMode::Followup,
        )
        .await;
        eventually("next turn", || running(t, id)).await;
    }
}

fn subagent_update(
    turn_id: Option<String>,
    subagent_id: &str,
    status: goat2_contracts::TurnItemStatus,
) -> goat2_host::engine::EngineEvent {
    goat2_host::engine::EngineEvent::SubagentUpdate {
        turn_id,
        subagent_id: subagent_id.into(),
        status,
        title: None,
        progress: None,
    }
}

fn emit_item(t: &T, id: &ThreadId, turn: &str, item: goat2_contracts::TurnItem) {
    t.fake.emit(
        id,
        goat2_host::engine::EngineEvent::ItemCompleted {
            turn_id: turn.to_owned(),
            item: Box::new(item),
            locator: None,
        },
    );
}

#[tokio::test]
async fn an_ended_subagent_keeps_its_origin_until_its_item_arrives() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "ended-origin", Some("turn 1")).await;
    eventually("turn 1", || running(&t, &id)).await;
    let first = t.fake.active_turn(&id).unwrap();
    let run1 = last_run(&t, &id).unwrap();
    t.fake.emit(
        &id,
        subagent_update(
            Some(first.clone()),
            "bg",
            goat2_contracts::TurnItemStatus::Running,
        ),
    );
    // It reports its end; its finished item only comes after 65 more turns.
    t.fake.emit(
        &id,
        subagent_update(
            Some(first.clone()),
            "bg",
            goat2_contracts::TurnItemStatus::Completed,
        ),
    );
    more_turns(&t, &id, 0, 65).await;
    emit_item(&t, &id, &first, subagent_item(&id, "bg-item", Some("bg")));
    eventually("subagent result", || item_run(&t, &id, "bg-item").is_some()).await;
    assert_eq!(item_run(&t, &id, "bg-item"), Some(run1));
}

#[tokio::test]
async fn an_ended_subagent_holds_the_idle_stop_until_its_item_arrives() {
    let t = setup_with(manual(), |o| o.idle_stop = Duration::from_millis(150)).await;
    let id = start_user_thread(&t, "ended-idle", Some("go")).await;
    eventually("running", || running(&t, &id)).await;
    let turn = t.fake.active_turn(&id).unwrap();
    t.fake.emit(
        &id,
        subagent_update(
            Some(turn.clone()),
            "bg",
            goat2_contracts::TurnItemStatus::Running,
        ),
    );
    t.fake.finish_turn(&id, "done for now");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    t.fake.emit(
        &id,
        subagent_update(
            Some(turn.clone()),
            "bg",
            goat2_contracts::TurnItemStatus::Completed,
        ),
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        !shut_down(&t, &id),
        "not idle-stopped while its item is on the way"
    );
    emit_item(&t, &id, &turn, subagent_item(&id, "bg-item", Some("bg")));
    eventually("idle stop after the item", || shut_down(&t, &id)).await;
    assert!(item_run(&t, &id, "bg-item").is_some());
}

#[tokio::test]
async fn an_ended_subagent_whose_item_never_comes_stops_holding_after_the_grace() {
    let t = setup_with(manual(), |o| {
        o.idle_stop = Duration::from_millis(150);
        o.subagent_item_grace = Duration::from_millis(400);
    })
    .await;
    let id = start_user_thread(&t, "ended-grace", Some("go")).await;
    eventually("running", || running(&t, &id)).await;
    let turn = t.fake.active_turn(&id).unwrap();
    t.fake.emit(
        &id,
        subagent_update(
            Some(turn.clone()),
            "bg",
            goat2_contracts::TurnItemStatus::Running,
        ),
    );
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    t.fake.emit(
        &id,
        subagent_update(Some(turn), "bg", goat2_contracts::TurnItemStatus::Completed),
    );
    eventually("idle stop after the grace", || shut_down(&t, &id)).await;
}

#[tokio::test]
async fn a_failed_approval_answer_never_returns_the_engine_text() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "approval-fail", Some("go")).await;
    eventually("running", || running(&t, &id)).await;
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::RequestOpened {
            turn_id: t.fake.active_turn(&id).unwrap(),
            key: "key-SECRET-1".into(),
            item_id: None,
            kind: RequestKind::Approval,
            summary: "Run the command?".into(),
            item: None,
        },
    );
    let approval = || {
        t.host
            .store()
            .fold(&id)
            .unwrap()
            .open_requests
            .iter()
            .find(|r| r.kind == RequestKind::Approval)
            .map(|r| r.request_id.clone())
    };
    eventually("approval open", || approval().is_some()).await;
    t.fake.fail_answers(true);
    let refused = t
        .host
        .command(ClientFrame::ResolveRequest {
            req_id: "r".into(),
            client_request_id: "approval-fail-1".into(),
            thread_id: id.clone(),
            request_id: approval().unwrap(),
            outcome: RequestOutcome::Accept,
            text: None,
            answers: None,
            option_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.message, "the engine did not take the answer");
}

fn signins(t: &T, id: &ThreadId) -> Vec<goat2_contracts::RequestOpened> {
    events(t, id)
        .into_iter()
        .filter_map(|e| match e {
            LogEvent::RequestOpened(o) if o.kind == RequestKind::Signin => Some(o),
            _ => None,
        })
        .collect()
}

fn last_run(t: &T, id: &ThreadId) -> Option<goat2_contracts::RunId> {
    events(t, id).into_iter().rev().find_map(|e| match e {
        LogEvent::RunStarted(s) => Some(s.run_id),
        _ => None,
    })
}

fn resolved_text(t: &T, id: &ThreadId, request_id: &goat2_contracts::RequestId) -> Option<String> {
    events(t, id).into_iter().find_map(|e| match e {
        LogEvent::RequestResolved(r) if &r.request_id == request_id => r.text,
        _ => None,
    })
}

/// Whether any file under the host's data dir contains `needle`.
fn data_contains(t: &T, needle: &str) -> bool {
    fn walk(dir: &std::path::Path, needle: &[u8]) -> bool {
        std::fs::read_dir(dir).unwrap().flatten().any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, needle)
            } else {
                std::fs::read(&path)
                    .is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle))
            }
        })
    }
    walk(t._dir.as_ref().unwrap().path(), needle.as_bytes())
}

#[tokio::test]
async fn usage_is_live_and_only_finished_snapshot_is_durable() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "usage", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    let (mut rx, _) = t.host.watch_thread(&id);
    let usage = |n| serde_json::from_value(serde_json::json!({"usedTokens": n})).unwrap();
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::TokenUsage {
            turn_id: Some("stale".into()),
            usage: usage(31_415_926),
        },
    );
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::TokenUsage {
            turn_id: None,
            usage: usage(27_182_818),
        },
    );
    let live = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let goat2_host::api::ThreadLive::Usage { usage, updated_at } =
                rx.recv().await.unwrap()
            {
                break (usage, updated_at);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(live.0.used_tokens, 27_182_818);
    assert!(chrono::DateTime::parse_from_rfc3339(&live.1).is_ok());
    t.fake.finish_turn(&id, "done");
    eventually("finished", || count(&t, &id, "run.finished") == 1).await;
    let finished = events(&t, &id)
        .into_iter()
        .find_map(|e| match e {
            LogEvent::RunFinished(e) => Some(e),
            _ => None,
        })
        .unwrap();
    assert_eq!(finished.token_usage.unwrap().used_tokens, 27_182_818);
    assert_eq!(
        t.host
            .store()
            .card(&id)
            .unwrap()
            .context_usage
            .unwrap()
            .used_tokens,
        27_182_818
    );
    assert!(!data_contains(&t, "thread_usage"));
    assert!(!data_contains(&t, "31415926"));
}

#[tokio::test]
async fn keyed_signin_answers_engine_and_declines_at_run_end() {
    for (requested, expected) in [
        (RequestOutcome::Answered, RequestOutcome::Accept),
        (RequestOutcome::Decline, RequestOutcome::Decline),
        (RequestOutcome::Cancel, RequestOutcome::Decline),
    ] {
        let t = setup(manual()).await;
        let id = start_user_thread(&t, "keyed", Some("hello")).await;
        eventually("running", || running(&t, &id)).await;
        t.fake.emit(
            &id,
            goat2_host::engine::EngineEvent::AuthRequired {
                key: Some("SECRET-KEY".into()),
                turn_id: t.fake.active_turn(&id),
                url: None,
                message: "signin".into(),
            },
        );
        eventually("signin", || !signins(&t, &id).is_empty()).await;
        let request_id = signins(&t, &id)[0].request_id.clone();
        t.host
            .command(ClientFrame::ResolveRequest {
                req_id: "r".into(),
                client_request_id: "resolve".into(),
                thread_id: id.clone(),
                request_id,
                outcome: requested,
                text: None,
                answers: None,
                option_id: None,
            })
            .await
            .unwrap();
        assert!(t.fake.calls().iter().any(|c| matches!(c, FakeCall::Answer { key, outcome, .. } if key == "SECRET-KEY" && *outcome == expected)));
        assert!(!data_contains(&t, "SECRET-KEY"));
    }
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "keyed-end", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::AuthRequired {
            key: Some("KEY-END".into()),
            turn_id: t.fake.active_turn(&id),
            url: None,
            message: "signin".into(),
        },
    );
    eventually("signin", || !signins(&t, &id).is_empty()).await;
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    assert!(t.fake.calls().iter().any(|c| matches!(c, FakeCall::Answer { key, outcome: RequestOutcome::Decline, .. } if key == "KEY-END")));
    assert!(!data_contains(&t, "KEY-END"));
}

#[tokio::test]
async fn a_repeated_keyed_signin_declines_the_replaced_key_and_errors_never_show_a_key() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "keyed-repeat", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    let auth = |key: &str| goat2_host::engine::EngineEvent::AuthRequired {
        key: Some(key.to_owned()),
        turn_id: t.fake.active_turn(&id),
        url: None,
        message: "signin".into(),
    };
    t.fake.emit(&id, auth("KEY-FIRST-7731"));
    eventually("signin", || !signins(&t, &id).is_empty()).await;
    t.fake.emit(&id, auth("KEY-SECOND-7732"));
    eventually("first key declined", || {
        t.fake.calls().iter().any(|c| matches!(c, FakeCall::Answer { key, outcome: RequestOutcome::Decline, .. } if key == "KEY-FIRST-7731"))
    })
    .await;
    assert_eq!(signins(&t, &id).len(), 1, "one request per scope");
    // The engine fails the answer with an error naming the key: the reply carries no key.
    t.fake.fail_answers(true);
    let request_id = signins(&t, &id)[0].request_id.clone();
    let reply = t
        .host
        .command(ClientFrame::ResolveRequest {
            req_id: "r".into(),
            client_request_id: "resolve-fail".into(),
            thread_id: id.clone(),
            request_id,
            outcome: RequestOutcome::Answered,
            text: None,
            answers: None,
            option_id: None,
        })
        .await;
    let shown = format!("{reply:?}");
    assert!(reply.is_err(), "{shown}");
    assert!(!shown.contains("KEY-SECOND-7732"), "{shown}");
    assert!(t.fake.calls().iter().any(|c| matches!(c, FakeCall::Answer { key, outcome: RequestOutcome::Accept, .. } if key == "KEY-SECOND-7732")));
    assert!(!data_contains(&t, "KEY-FIRST-7731"));
    assert!(!data_contains(&t, "KEY-SECOND-7732"));
}

#[tokio::test]
async fn a_late_keyed_signin_is_declined_and_a_failed_decline_is_retried() {
    // A keyed sign-in naming a turn that already ended is declined, not left waiting.
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "keyed-late", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    let ended = t.fake.active_turn(&id).unwrap();
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    t.fake.emit(
        &id,
        goat2_host::engine::EngineEvent::AuthRequired {
            key: Some("KEY-LATE-4401".into()),
            turn_id: Some(ended),
            url: None,
            message: "signin".into(),
        },
    );
    eventually("late key declined", || {
        t.fake.calls().iter().any(|c| matches!(c, FakeCall::Answer { key, outcome: RequestOutcome::Decline, .. } if key == "KEY-LATE-4401"))
    })
    .await;
    assert!(signins(&t, &id).is_empty(), "no request for an ended turn");

    // A decline that fails while a newer key replaces the old one is retried at run end.
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "keyed-retry", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    let auth = |key: &str| goat2_host::engine::EngineEvent::AuthRequired {
        key: Some(key.to_owned()),
        turn_id: t.fake.active_turn(&id),
        url: None,
        message: "signin".into(),
    };
    t.fake.emit(&id, auth("KEY-OLD-4402"));
    eventually("signin", || !signins(&t, &id).is_empty()).await;
    t.fake.fail_answers(true);
    t.fake.emit(&id, auth("KEY-NEW-4403"));
    let declines = |key: &'static str| {
        t.fake
            .calls()
            .iter()
            .filter(|c| matches!(c, FakeCall::Answer { key: k, outcome: RequestOutcome::Decline, .. } if k == key))
            .count()
    };
    eventually("first decline attempted", || declines("KEY-OLD-4402") == 1).await;
    t.fake.fail_answers(false);
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    eventually("old key retried", || declines("KEY-OLD-4402") == 2).await;
    assert_eq!(
        declines("KEY-NEW-4403"),
        1,
        "the current key is declined at run end"
    );
    assert!(!data_contains(&t, "KEY-OLD-4402"));
}

#[tokio::test]
async fn a_key_answered_after_a_failed_decline_is_never_declined_later() {
    let t = setup(manual()).await;
    let id = start_user_thread(&t, "keyed-aba", Some("hello")).await;
    eventually("running", || running(&t, &id)).await;
    let auth = |key: &str| goat2_host::engine::EngineEvent::AuthRequired {
        key: Some(key.to_owned()),
        turn_id: t.fake.active_turn(&id),
        url: None,
        message: "signin".into(),
    };
    let answers = |key: &'static str, outcome: RequestOutcome| {
        t.fake
            .calls()
            .iter()
            .filter(|c| matches!(c, FakeCall::Answer { key: k, outcome: o, .. } if k == key && *o == outcome))
            .count()
    };
    // A, then B while declines fail (A waits for a retry), then A again.
    t.fake.emit(&id, auth("KEY-A-5501"));
    eventually("signin", || !signins(&t, &id).is_empty()).await;
    t.fake.fail_answers(true);
    t.fake.emit(&id, auth("KEY-B-5502"));
    eventually("A decline failed", || {
        answers("KEY-A-5501", RequestOutcome::Decline) == 1
    })
    .await;
    t.fake.emit(&id, auth("KEY-B-5502"));
    t.fake.emit(&id, auth("KEY-A-5501"));
    eventually("B decline attempted", || {
        answers("KEY-B-5502", RequestOutcome::Decline) >= 1
    })
    .await;
    t.fake.fail_answers(false);
    // The person accepts A; the run end must not decline it afterwards.
    let request_id = signins(&t, &id)[0].request_id.clone();
    t.host
        .command(ClientFrame::ResolveRequest {
            req_id: "r".into(),
            client_request_id: "resolve-a".into(),
            thread_id: id.clone(),
            request_id,
            outcome: RequestOutcome::Answered,
            text: None,
            answers: None,
            option_id: None,
        })
        .await
        .unwrap();
    assert_eq!(answers("KEY-A-5501", RequestOutcome::Accept), 1);
    t.fake.finish_turn(&id, "done");
    eventually("run finished", || count(&t, &id, "run.finished") == 1).await;
    eventually("B retried", || {
        answers("KEY-B-5502", RequestOutcome::Decline) >= 2
    })
    .await;
    assert_eq!(
        answers("KEY-A-5501", RequestOutcome::Decline),
        1,
        "A was only declined while it was replaced"
    );
    let b_retries = answers("KEY-B-5502", RequestOutcome::Decline);
    assert_eq!(b_retries, 2, "B is queued once and retried once");
}

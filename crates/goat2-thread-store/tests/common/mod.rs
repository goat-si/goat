#![allow(dead_code)]

use std::path::Path;

use goat2_thread_store::contract::*;
use goat2_thread_store::fold;
use goat2_thread_store::{StartupReport, Store, StoreOptions};
use serde_json::json;

pub fn open(dir: &Path) -> (Store, StartupReport) {
    Store::open(dir, StoreOptions::default()).expect("open store")
}

pub fn tid(s: &str) -> ThreadId {
    ThreadId::new(s)
}

pub fn created(title: &str, cwd: &str) -> ThreadCreated {
    ThreadCreated {
        kind: ThreadKind::User,
        title: title.into(),
        project_id: Some(ProjectId::new("proj-1")),
        bot_id: None,
        parent: None,
        engine: EngineConfig {
            driver: EngineDriver::Codex,
            model: "gpt-test".into(),
            runtime_mode: "full-access".into(),
            cwd: cwd.into(),
        },
        follow_up_mode: FollowUpMode::Steer,
    }
}

pub fn child_created(title: &str, parent: &str) -> ThreadCreated {
    let mut c = created(title, "/work");
    c.kind = ThreadKind::Worker;
    c.parent = Some(ParentRef {
        thread_id: ThreadId::new(parent),
        by_item_id: ItemId::new("tool-1"),
    });
    c
}

pub fn input(id: &str, text: &str) -> LogEvent {
    input_mode(id, text, InputMode::Followup)
}

pub fn input_mode(id: &str, text: &str, mode: InputMode) -> LogEvent {
    LogEvent::InputAccepted(InputAccepted {
        input_id: InputId::new(id),
        from: InputSource::User,
        mode,
        text: text.into(),
        attachments: Vec::new(),
        client_request_id: format!("cr-{id}"),
    })
}

pub fn started(run: &str, inputs: &[&str]) -> LogEvent {
    LogEvent::RunStarted(RunStarted {
        run_id: RunId::new(run),
        input_ids: inputs.iter().map(|i| InputId::new(*i)).collect(),
        generation: 1,
        engine_ref: Some(EngineRef {
            driver: EngineDriver::Codex,
            id: "codex-thread-1".into(),
        }),
    })
}

pub fn accepted(run: &str) -> LogEvent {
    LogEvent::RunAccepted(RunAccepted {
        run_id: RunId::new(run),
        engine_turn_ref: EngineTurnRef {
            driver: EngineDriver::Codex,
            id: format!("turn-{run}"),
        },
    })
}

pub fn delivered(input: &str, run: &str, as_: DeliveredAs, outcome: DeliveryOutcome) -> LogEvent {
    LogEvent::InputDelivered(InputDelivered {
        input_id: InputId::new(input),
        run_id: RunId::new(run),
        delivered_as: as_,
        outcome,
    })
}

fn item_json(run: &str, id: &str, body: serde_json::Value) -> serde_json::Value {
    let mut item = json!({
        "id": id, "threadId": "t", "runId": run, "providerThreadId": null, "providerTurnId": "turn-1",
        "nativeItemRef": null, "parentItemId": null, "ordinal": 1, "status": "completed", "title": null,
        "startedAt": null, "completedAt": "2026-11-28T10:00:00Z", "updatedAt": "2026-11-28T10:00:00Z"
    });
    for (k, v) in body.as_object().unwrap() {
        item[k] = v.clone();
    }
    json!({ "runId": run, "item": item, "engineLocator": { "turnId": "turn-1", "itemId": id } })
}

pub fn item(run: &str, id: &str, body: serde_json::Value) -> LogEvent {
    LogEvent::ItemCompleted(serde_json::from_value(item_json(run, id, body)).expect("item json"))
}

pub fn answer(run: &str, id: &str, text: &str) -> LogEvent {
    item(
        run,
        id,
        json!({"type": "assistant_message", "messageId": format!("m-{id}"), "text": text, "streaming": false}),
    )
}

pub fn request(id: &str, run: Option<&str>, kind: RequestKind) -> LogEvent {
    LogEvent::RequestOpened(RequestOpened {
        request_id: RequestId::new(id),
        run_id: run.map(RunId::new),
        item_id: None,
        kind,
        summary: format!("request {id}"),
        options: None,
        recommended: None,
    })
}

pub fn resolved(id: &str, outcome: RequestOutcome) -> LogEvent {
    LogEvent::RequestResolved(RequestResolved {
        request_id: RequestId::new(id),
        outcome,
        option_id: None,
        text: None,
        answers: None,
    })
}

pub fn finished(run: &str, outcome: RunOutcome) -> LogEvent {
    LogEvent::RunFinished(RunFinished {
        run_id: RunId::new(run),
        outcome,
        reason: None,
    })
}

pub fn child_started(child: &str) -> LogEvent {
    LogEvent::ChildStarted(ChildStarted {
        child_thread_id: ThreadId::new(child),
        task: "do it".into(),
        by_item_id: ItemId::new("tool-1"),
    })
}

pub fn child_reported(child: &str, epoch: &Epoch) -> LogEvent {
    LogEvent::ChildReported(ChildReported {
        child_thread_id: ThreadId::new(child),
        child_run_id: None,
        status: ChildResultStatus::Done,
        summary: "ok".into(),
        child_cursor: ThreadCursor {
            epoch: epoch.clone(),
            seq: 3,
        },
    })
}

pub fn notified(text: &str) -> LogEvent {
    LogEvent::UserNotified(UserNotified {
        run_id: None,
        kind: NotifyKind::Result,
        text: text.into(),
    })
}

pub fn renamed(title: &str) -> LogEvent {
    LogEvent::ThreadChanged(ThreadChanged {
        title: Some(title.into()),
        ..Default::default()
    })
}

/// One complete run: input, start, accept, delivered, answer, finish(done).
pub fn full_run(run: &str, input_id: &str, text: &str) -> Vec<LogEvent> {
    vec![
        input(input_id, text),
        started(run, &[input_id]),
        accepted(run),
        delivered(input_id, run, DeliveredAs::Turn, DeliveryOutcome::Accepted),
        answer(run, &format!("{run}-a"), &format!("answer to {text}")),
        finished(run, RunOutcome::Done),
    ]
}

pub fn log_path(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join("threads").join(id).join("goat.jsonl")
}

pub fn log_text(dir: &Path, id: &str) -> String {
    std::fs::read_to_string(log_path(dir, id)).expect("read log")
}

/// Oracle: fold the whole log from disk with the public fold functions.
pub fn replay(dir: &Path, id: &str) -> (ThreadCard, Fold) {
    let text = log_text(dir, id);
    let mut lines = text.lines();
    let header: LogHeader = serde_json::from_str(lines.next().unwrap()).unwrap();
    let mut state: Option<(ThreadCard, Fold)> = None;
    for raw in lines {
        match parse_log_line(raw).expect("parse") {
            ParsedLine::Known(line) => match (&line.event, &mut state) {
                (LogEvent::ThreadCreated(c), None) => {
                    state = Some(fold::initial(
                        &ThreadId::new(id),
                        c,
                        &header.epoch,
                        line.seq,
                        &line.at,
                    ))
                }
                (_, Some((card, f))) => fold::apply(card, f, &line),
                _ => panic!("first line is not thread.created"),
            },
            ParsedLine::Unknown { seq, .. } => state.as_mut().unwrap().0.applied_seq = seq,
        }
    }
    state.unwrap()
}

/// Compare cards ignoring the index-assigned cardSeq.
pub fn same_card(a: &ThreadCard, b: &ThreadCard) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.card_seq = 0;
    b.card_seq = 0;
    a == b
}

pub fn append_raw(dir: &Path, id: &str, bytes: &[u8]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(log_path(dir, id))
        .unwrap();
    f.write_all(bytes).unwrap();
}

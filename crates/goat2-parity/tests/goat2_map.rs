use goat2_contracts::log::{InputChanged, InputMode, LogEvent};
use goat2_parity::{
    goat2_map::AliasMap,
    trace::{QueueOp, TraceEvent},
};
#[test]
fn input_changed_and_unknown() {
    let mut aliases = AliasMap::default();
    aliases.register_request_mode("req", "i", goat2_parity::scenario::SendMode::Queue);
    let accepted: LogEvent = serde_json::from_value(serde_json::json!({"type":"input.accepted", "inputId":"raw", "from":{"kind":"user"}, "mode":"followup", "text":"x", "clientRequestId":"req"})).unwrap();
    aliases.map("t", &accepted).unwrap();
    let mut e = InputChanged {
        input_id: "raw".into(),
        text: Some("edit".into()),
        position: Some(2),
        mode: Some(InputMode::Steer),
        cancelled: Some(true),
    };
    let events = aliases
        .map("t", &LogEvent::InputChanged(e.clone()))
        .unwrap();
    assert!(matches!(
        &events[..],
        [
            TraceEvent::QueueChanged {
                op: QueueOp::Edited,
                ..
            },
            TraceEvent::QueueChanged {
                op: QueueOp::Reordered,
                position: Some(2),
                ..
            },
            TraceEvent::QueueChanged {
                op: QueueOp::Promoted,
                ..
            },
            TraceEvent::QueueChanged {
                op: QueueOp::Cancelled,
                ..
            }
        ]
    ));
    e.cancelled = Some(false);
    assert!(
        aliases
            .map("t", &LogEvent::InputChanged(e.clone()))
            .is_err()
    );
    e.cancelled = None;
    e.mode = Some(InputMode::Followup);
    assert!(
        aliases
            .map("t", &LogEvent::InputChanged(e.clone()))
            .is_err()
    );
    e.mode = None;
    e.text = None;
    e.position = None;
    assert!(aliases.map("t", &LogEvent::InputChanged(e)).is_err());
    let mut incomplete = false;
    assert!(
        aliases
            .map_line("t", r#"{"v":1,"seq":1,"type":"future"}"#, &mut incomplete)
            .unwrap()
            .is_empty()
    );
    assert!(incomplete);
}

#[test]
fn maps_aliases_and_correlates_child_wakes() {
    use goat2_parity::trace::WakeState;
    let event = |v| serde_json::from_value::<LogEvent>(v).unwrap();
    let mut m = AliasMap::default();
    let child_started = event(
        serde_json::json!({"type":"child.started","childThreadId":"raw-child","task":"task","byItemId":"item"}),
    );
    assert!(m.map("parent", &child_started).is_err());
    m.register_child("raw-child", "kid");
    assert!(
        matches!(&m.map("parent",&child_started).unwrap()[..], [TraceEvent::ChildStarted{child,..}] if child=="kid")
    );
    let report = event(
        serde_json::json!({"type":"child.reported","childThreadId":"raw-child","childRunId":null,"status":"completed","summary":"ok","childCursor":{"epoch":"e","seq":1}}),
    );
    assert!(
        matches!(&m.map("parent",&report).unwrap()[..], [TraceEvent::ChildReported{child,..}] if child=="kid")
    );
    m.bind_child_input("child-input", "w1").unwrap();
    let accepted = event(
        serde_json::json!({"type":"input.accepted","inputId":"child-input","from":{"kind":"child","threadId":"raw-child"},"mode":"followup","text":"hello","clientRequestId":"generated"}),
    );
    assert!(
        matches!(&m.map("parent",&accepted).unwrap()[..], [TraceEvent::InputAccepted{input,..}] if input=="kid#1")
    );
    let started = event(
        serde_json::json!({"type":"run.started","runId":"raw-run","inputIds":["child-input"],"generation":1,"engineRef":null}),
    );
    assert!(
        matches!(&m.map("parent",&started).unwrap()[..], [TraceEvent::RunStarted{run,inputs,..},TraceEvent::ParentWoken{child,wake,state:WakeState::Started,..}] if run=="r1" && inputs== &["kid#1"] && child=="kid" && wake=="w1")
    );
    let delivered = event(
        serde_json::json!({"type":"input.delivered","inputId":"child-input","runId":"raw-run","as":"steer","outcome":"accepted"}),
    );
    assert!(
        matches!(&m.map("parent",&delivered).unwrap()[..], [TraceEvent::SteerApplied{run,input,..},TraceEvent::ParentWoken{state:WakeState::Steered,..}] if run=="r1" && input=="kid#1")
    );
    let missing = event(serde_json::json!({"type":"input.changed","inputId":"missing","text":"x"}));
    assert!(m.map("parent", &missing).is_err());
    assert!(m.map("other-thread", &started).is_err());
}

#[test]
fn inflight_steer_in_fold_never_proves_enqueue() {
    use goat2_contracts::log::{Fold, InputSource, QueuedInput};
    let mut fold = Fold {
        active_run_id: Some("run".into()),
        ..Default::default()
    };
    fold.queued_inputs.push(QueuedInput {
        input_id: "raw".into(),
        text: "x".into(),
        mode: InputMode::Steer,
        source: InputSource::User,
        attachments: vec![],
    });
    let mut aliases = AliasMap::default();
    aliases.register_request("req", "i");
    let event: LogEvent=serde_json::from_value(serde_json::json!({"type":"input.accepted","inputId":"raw","from":{"kind":"user"},"mode":"steer","text":"x","clientRequestId":"req"})).unwrap();
    assert!(fold.active_run_id.is_some());
    assert!(!aliases.map("t", &event).unwrap().iter().any(|e| matches!(
        e,
        TraceEvent::QueueChanged {
            op: QueueOp::Enqueued,
            ..
        }
    )));
}

#[test]
fn child_input_aliases_follow_report_order_even_if_admitted_in_reverse() {
    let event = |v| serde_json::from_value::<LogEvent>(v).unwrap();
    let mut m = AliasMap::default();
    m.register_child("child", "kid");
    let report = event(
        serde_json::json!({"type":"child.reported","childThreadId":"child","childRunId":null,"status":"completed","summary":"ok","childCursor":{"epoch":"e","seq":1}}),
    );
    m.map("parent", &report).unwrap();
    m.map("parent", &report).unwrap();
    m.bind_child_input("one", "w1").unwrap();
    assert!(m.bind_child_input("another", "w1").is_err());
    m.bind_child_input("two", "w2").unwrap();
    for (raw, expected) in [("two", "kid#2"), ("one", "kid#1")] {
        let accepted = event(
            serde_json::json!({"type":"input.accepted","inputId":raw,"from":{"kind":"child","threadId":"child"},"mode":"steer","text":"x","clientRequestId":"req"}),
        );
        assert!(
            matches!(&m.map("parent", &accepted).unwrap()[..], [TraceEvent::InputAccepted { input, .. }] if input == expected)
        );
    }
}

fn frozen_event(tag: &str) -> LogEvent {
    let line = include_str!("../../goat2-contracts/tests/frozen_v1/goat.jsonl")
        .lines()
        .find(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["type"] == tag)
        .unwrap();
    serde_json::from_str(line).unwrap()
}
fn prepared_aliases() -> AliasMap {
    let mut m = AliasMap::default();
    m.register_request_mode("cr-1", "i1", goat2_parity::scenario::SendMode::Queue);
    m.register_request_mode("cr-2", "i2", goat2_parity::scenario::SendMode::Queue);
    m.register_child("thr-worker-1", "kid");
    m.map("t", &frozen_event("input.accepted")).unwrap();
    m.map("t", &frozen_event("run.started")).unwrap();
    m
}
macro_rules! frozen_mapping {
    ($name:ident, $tag:literal, $expected:expr) => {
        #[test]
        fn $name() {
            let mut m = prepared_aliases();
            let event = frozen_event($tag);
            let actual = m.map("t", &event).unwrap();
            let expected: Vec<TraceEvent> = serde_json::from_value($expected).unwrap();
            assert_eq!(actual, expected);
        }
    };
}
frozen_mapping!(map_thread_created, "thread.created", serde_json::json!([]));
frozen_mapping!(map_thread_changed, "thread.changed", serde_json::json!([]));
frozen_mapping!(
    map_input_accepted,
    "input.accepted",
    serde_json::json!([{"kind":"input.accepted","thread":"t","input":"i1","from":"user","mode":"queue","text":"Review PR #12 and tell me what is risky."}])
);
frozen_mapping!(
    map_input_delivered,
    "input.delivered",
    serde_json::json!([])
);
frozen_mapping!(
    map_run_started,
    "run.started",
    serde_json::json!([{"kind":"run.started","thread":"t","run":"r1","inputs":["i1"]}])
);
frozen_mapping!(map_run_accepted, "run.accepted", serde_json::json!([]));
frozen_mapping!(map_item_completed, "item.completed", serde_json::json!([]));
frozen_mapping!(map_request_opened, "request.opened", serde_json::json!([]));
frozen_mapping!(
    map_request_resolved,
    "request.resolved",
    serde_json::json!([])
);
frozen_mapping!(
    map_run_finished,
    "run.finished",
    serde_json::json!([{"kind":"run.finished","thread":"t","run":"r1","status":"done"}])
);
frozen_mapping!(
    map_child_started,
    "child.started",
    serde_json::json!([{"kind":"child.started","thread":"t","child":"kid"}])
);
frozen_mapping!(
    map_child_reported,
    "child.reported",
    serde_json::json!([{"kind":"child.reported","thread":"t","child":"kid","status":"completed"}])
);
frozen_mapping!(map_user_notified, "user.notified", serde_json::json!([]));
frozen_mapping!(map_checkpoint, "checkpoint", serde_json::json!([]));
#[test]
fn map_input_changed() {
    let mut m = prepared_aliases();
    let accepted: LogEvent = serde_json::from_value(serde_json::json!({"type":"input.accepted","inputId":"in-2","from":{"kind":"user"},"mode":"followup","text":"Also check the migration","clientRequestId":"cr-2"})).unwrap();
    m.map("t", &accepted).unwrap();
    let expected: Vec<TraceEvent> = serde_json::from_value(serde_json::json!([{"kind":"queue.changed","thread":"t","input":"i2","op":"edited","text":"Also check the migration and the rollback"}])).unwrap();
    assert_eq!(
        m.map("t", &frozen_event("input.changed")).unwrap(),
        expected
    );
}
#[test]
fn checkpoint_with_inflight_steer_does_not_emit_queue_changed() {
    use goat2_contracts::log::{InputSource, QueuedInput};
    let LogEvent::Checkpoint(mut checkpoint) = frozen_event("checkpoint") else {
        panic!("checkpoint fixture")
    };
    checkpoint.fold.active_run_id = Some("run".into());
    checkpoint.fold.queued_inputs = vec![QueuedInput {
        input_id: "steer".into(),
        text: "x".into(),
        mode: InputMode::Steer,
        source: InputSource::User,
        attachments: vec![],
    }];
    assert!(
        prepared_aliases()
            .map("t", &LogEvent::Checkpoint(checkpoint))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn map_input_delivered_refused_fails_closed() {
    let mut m = prepared_aliases();
    let mut value = serde_json::to_value(frozen_event("input.delivered")).unwrap();
    value["outcome"] = serde_json::json!("refused");
    let event: LogEvent = serde_json::from_value(value).unwrap();
    let actual = m.map("t", &event).unwrap();
    assert!(
        matches!(actual.as_slice(), [TraceEvent::InputRefused { code, .. }] if code == "delivery_refused"),
        "{actual:?}"
    );
}

use goat2_parity::{
    compare::compare,
    scenario::{LoadedScenario, Scenario, SupportStatus},
    trace::{ObservedTrace, Outcome},
};
use std::collections::BTreeMap;
fn fixture() -> (LoadedScenario, ObservedTrace) {
    let parts: Vec<_> = include_str!("../README.md")
        .split("```json\n")
        .skip(1)
        .map(|s| s.split("\n```").next().unwrap())
        .collect();
    let mut scenario: Scenario = serde_json::from_str(parts[0]).unwrap();
    scenario.targets.get_mut("v1").unwrap().status = SupportStatus::Supported;
    let observed: ObservedTrace = serde_json::from_str(parts[1]).unwrap();
    (
        LoadedScenario {
            dir: Default::default(),
            scenario,
            outbound_counts: BTreeMap::from([("main".into(), 1)]),
        },
        observed,
    )
}
#[test]
fn matching_and_pending_status() {
    let (mut s, o) = fixture();
    assert!(compare(&s, &o).passed());
    s.scenario.targets.get_mut("v1").unwrap().status = SupportStatus::Pending;
    assert!(matches!(
        compare(&s, &o).outcome,
        Outcome::PendingExpectation { .. }
    ));
    s.scenario.targets.get_mut("v1").unwrap().status = SupportStatus::Supported;
    s.scenario.expect.complete = false;
    assert!(!compare(&s, &o).passed());
}
#[test]
fn mismatch_and_stream_failures() {
    let (s, mut o) = fixture();
    o.events.clear();
    assert!(!compare(&s, &o).passed());
    let (_, mut o) = fixture();
    o.events.push(o.events[0].clone());
    assert!(!compare(&s, &o).passed());
    let (_, mut o) = fixture();
    if let goat2_parity::trace::TraceEvent::InputAccepted { text, .. } = &mut o.events[0].event {
        *text = Some("wrong".into());
    }
    assert!(!compare(&s, &o).passed());
    let (_, mut o) = fixture();
    o.streams.get_mut("main").unwrap().outbound_checked = 0;
    assert!(!compare(&s, &o).passed());
    o.streams.get_mut("main").unwrap().outbound_checked = 1;
    o.streams.get_mut("main").unwrap().consumed_all = false;
    assert!(!compare(&s, &o).passed());
    o.streams.get_mut("main").unwrap().consumed_all = true;
    o.streams
        .get_mut("main")
        .unwrap()
        .outbound_mismatches
        .push("wrong".into());
    assert!(!compare(&s, &o).passed());
}
#[test]
fn non_ok_and_unknown_never_pass() {
    let (s, mut o) = fixture();
    for outcome in [
        Outcome::Unsupported { reason: "x".into() },
        Outcome::Error { reason: "x".into() },
        Outcome::Incomplete { reason: "x".into() },
        Outcome::PendingExpectation { reason: "x".into() },
    ] {
        o.outcome = outcome;
        assert!(!compare(&s, &o).passed());
    }
    o.outcome = Outcome::Ok;
    o.incomplete = true;
    assert!(matches!(
        compare(&s, &o).outcome,
        Outcome::Incomplete { .. }
    ));
}

#[test]
fn ordering_override_and_happens_before() {
    use goat2_parity::trace::{ExpectedEvent, ObservedEvent, TraceEvent};
    let (mut s, mut o) = fixture();
    let first = s.scenario.expect.threads["main"][0].clone();
    let second = ExpectedEvent {
        id: "e2".into(),
        event: TraceEvent::HostRestarted {
            thread: "main".into(),
        },
    };
    s.scenario
        .expect
        .exhaustive
        .insert(goat2_parity::trace::TraceKind::HostRestarted);
    s.scenario
        .expect
        .threads
        .get_mut("main")
        .unwrap()
        .push(second.clone());
    s.scenario
        .expect
        .happens_before
        .push((first.id.clone(), second.id.clone()));
    o.events.push(ObservedEvent {
        seq: 2,
        event: second.event.clone(),
    });
    assert!(compare(&s, &o).passed());
    o.events[1].seq = 0;
    assert!(!compare(&s, &o).passed());
    o.events[1].seq = 2;
    // Array order is not observation order; only the sequence numbers are.
    o.events.swap(0, 1);
    assert!(compare(&s, &o).passed());
    o.events.swap(0, 1);
    o.events.pop();
    let mut replacement = s.scenario.expect.clone();
    replacement.threads.get_mut("main").unwrap().pop();
    replacement.happens_before.clear();
    s.scenario.targets.get_mut("v1").unwrap().expect = Some(replacement);
    assert!(compare(&s, &o).passed());
}

#[test]
fn cross_thread_happens_before_uses_global_sequence() {
    use goat2_parity::trace::{ExpectedEvent, ObservedEvent, TraceEvent, TraceKind};
    let (mut s, mut o) = fixture();
    s.scenario
        .expect
        .exhaustive
        .insert(TraceKind::HostRestarted);
    s.scenario.expect.threads.insert(
        "other".into(),
        vec![ExpectedEvent {
            id: "other-event".into(),
            event: TraceEvent::HostRestarted {
                thread: "other".into(),
            },
        }],
    );
    s.scenario
        .expect
        .happens_before
        .push(("e1".into(), "other-event".into()));
    o.events.push(ObservedEvent {
        seq: 2,
        event: TraceEvent::HostRestarted {
            thread: "other".into(),
        },
    });
    assert!(compare(&s, &o).passed());
    o.events[0].seq = 3;
    assert!(!compare(&s, &o).passed());
}
#[test]
fn wrong_reordered_position_is_a_mismatch() {
    use goat2_parity::trace::{ExpectedEvent, ObservedEvent, QueueOp, TraceEvent, TraceKind};
    let (mut s, mut o) = fixture();
    let event = TraceEvent::QueueChanged {
        thread: "main".into(),
        input: "i1".into(),
        op: QueueOp::Reordered,
        text: None,
        position: Some(1),
    };
    s.scenario.expect.exhaustive.insert(TraceKind::QueueChanged);
    s.scenario
        .expect
        .threads
        .get_mut("main")
        .unwrap()
        .push(ExpectedEvent {
            id: "e2".into(),
            event: event.clone(),
        });
    o.events.push(ObservedEvent { seq: 2, event });
    assert!(compare(&s, &o).passed());
    if let TraceEvent::QueueChanged { position, .. } = &mut o.events[1].event {
        *position = Some(2);
    }
    assert!(!compare(&s, &o).passed());
}
#[test]
fn supported_and_pending_same_trace() {
    let (mut s, mut o) = fixture();
    s.scenario.targets.get_mut("v1").unwrap().status = SupportStatus::Pending;
    assert!(matches!(
        compare(&s, &o).outcome,
        Outcome::PendingExpectation { .. }
    ));
    s.scenario.targets.get_mut("v1").unwrap().status = SupportStatus::Supported;
    assert!(compare(&s, &o).passed());
    o.events.clear();
    assert!(!compare(&s, &o).passed());
}
#[test]
fn wrong_observed_version_is_rejected() {
    let (s, mut o) = fixture();
    o.v = 2;
    assert!(matches!(compare(&s, &o).outcome, Outcome::Error { .. }));
}
#[test]
fn goat2_override_replaces_default_only_for_goat2() {
    let (mut s, mut o) = fixture();
    let mut target = s.scenario.targets["v1"].clone();
    let mut replacement = s.scenario.expect.clone();
    replacement.threads.get_mut("main").unwrap().clear();
    target.expect = Some(replacement);
    s.scenario.targets.insert("goat2".into(), target);
    assert!(compare(&s, &o).passed());
    o.target = "goat2".into();
    assert!(!compare(&s, &o).passed());
    o.events.clear();
    assert!(compare(&s, &o).passed());
    o.target = "v1".into();
    assert!(!compare(&s, &o).passed());
}

macro_rules! compare_failure {
    ($name:ident, |$s:ident, $o:ident| $body:block) => {
        #[test] #[allow(unused_mut)] fn $name() { let (mut $s, mut $o) = fixture(); $body assert!(!compare(&$s, &$o).passed()); }
    };
}
compare_failure!(missing_event, |s, o| {
    o.events.clear();
});
compare_failure!(extra_exhaustive_event, |s, o| {
    o.events.push(o.events[0].clone());
});
compare_failure!(wrong_input_text, |s, o| {
    if let goat2_parity::trace::TraceEvent::InputAccepted { text, .. } = &mut o.events[0].event {
        *text = Some("wrong".into());
    } else {
        panic!("unexpected fixture");
    }
});
compare_failure!(outcome_unsupported_never_passes, |s, o| {
    o.outcome = Outcome::Unsupported { reason: "x".into() };
});
compare_failure!(outcome_error_never_passes, |s, o| {
    o.outcome = Outcome::Error { reason: "x".into() };
});
compare_failure!(outcome_incomplete_never_passes, |s, o| {
    o.outcome = Outcome::Incomplete { reason: "x".into() };
});
compare_failure!(pending_when_expect_incomplete, |s, o| {
    s.scenario.expect.complete = false;
    assert!(matches!(
        compare(&s, &o).outcome,
        Outcome::PendingExpectation { .. }
    ));
});
compare_failure!(stream_not_consumed_fails, |s, o| {
    o.streams.get_mut("main").unwrap().consumed_all = false;
});
compare_failure!(outbound_mismatch_fails, |s, o| {
    o.streams
        .get_mut("main")
        .unwrap()
        .outbound_mismatches
        .push("wrong".into());
});
compare_failure!(outbound_count_mismatch_fails, |s, o| {
    o.streams.get_mut("main").unwrap().outbound_checked = 0;
});
#[test]
fn reordered_events() {
    use goat2_parity::trace::{ExpectedEvent, ObservedEvent, TraceEvent, TraceKind};
    let (mut s, mut o) = fixture();
    let event = TraceEvent::HostRestarted {
        thread: "main".into(),
    };
    s.scenario
        .expect
        .exhaustive
        .insert(TraceKind::HostRestarted);
    s.scenario
        .expect
        .threads
        .get_mut("main")
        .unwrap()
        .push(ExpectedEvent {
            id: "e2".into(),
            event: event.clone(),
        });
    o.events.push(ObservedEvent { seq: 2, event });
    assert!(compare(&s, &o).passed());
    // Array order carries no meaning: the same sequence numbers in a different array order still pass.
    o.events.swap(0, 1);
    assert!(compare(&s, &o).passed());
    // Swapping the sequence numbers reverses the observed order and must fail.
    let (a, b) = (o.events[0].seq, o.events[1].seq);
    o.events[0].seq = b;
    o.events[1].seq = a;
    assert!(!compare(&s, &o).passed());
}

#[test]
fn reversed_sequence_numbers_in_expected_array_order_fail() {
    use goat2_parity::trace::{ExpectedEvent, ObservedEvent, TraceEvent, TraceKind};
    let (mut s, mut o) = fixture();
    let event = TraceEvent::HostRestarted {
        thread: "main".into(),
    };
    s.scenario
        .expect
        .exhaustive
        .insert(TraceKind::HostRestarted);
    s.scenario
        .expect
        .threads
        .get_mut("main")
        .unwrap()
        .push(ExpectedEvent {
            id: "e2".into(),
            event: event.clone(),
        });
    o.events.push(ObservedEvent { seq: 2, event });
    assert!(compare(&s, &o).passed());
    // Keep the array in expected order but number it backwards (the reviewer's 3,2,1 case).
    let n = o.events.len() as u64;
    for (i, e) in o.events.iter_mut().enumerate() {
        e.seq = n - i as u64;
    }
    assert!(!compare(&s, &o).passed());
}

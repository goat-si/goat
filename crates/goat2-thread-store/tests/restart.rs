mod common;

use common::*;
use goat2_thread_store::contract::*;
use goat2_thread_store::{StoreError, testing};

fn settle_with(evidence: Vec<LogEvent>) -> (RunOutcome, ThreadCard) {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("s", "/w"))
            .unwrap();
        let mut events = vec![input("i1", "x"), started("r1", &["i1"])];
        events.extend(evidence);
        store.append(&t, events).unwrap();
        testing::crash(store);
    }
    let (store, report) = open(dir.path());
    assert_eq!(report.settled.len(), 1);
    let (card, _) = replay(dir.path(), "t");
    assert!(same_card(&store.card(&t).unwrap().unwrap(), &card));
    (report.settled[0].outcome, card)
}

#[test]
fn settlement_is_interrupted_with_engine_evidence_and_unknown_without() {
    assert_eq!(settle_with(vec![accepted("r1")]).0, RunOutcome::Interrupted);
    assert_eq!(
        settle_with(vec![answer("r1", "a", "partial")]).0,
        RunOutcome::Interrupted
    );
    assert_eq!(
        settle_with(vec![delivered(
            "i1",
            "r1",
            DeliveredAs::Turn,
            DeliveryOutcome::Accepted
        )])
        .0,
        RunOutcome::Interrupted
    );
    let (outcome, card) = settle_with(vec![]);
    assert_eq!(outcome, RunOutcome::Unknown);
    assert_eq!(card.status, ThreadStatus::NeedsYou);
    assert_eq!(card.needs_you.unwrap().kind, RequestKind::Resend);
    let (outcome, _) = settle_with(vec![
        input("s1", "steer"),
        delivered("s1", "r1", DeliveredAs::Steer, DeliveryOutcome::Accepted),
    ]);
    assert_eq!(
        outcome,
        RunOutcome::Unknown,
        "steer deliveries are not turn evidence"
    );
}

#[test]
fn settlement_cancels_requests_of_the_dead_run() {
    let (outcome, card) = settle_with(vec![request("q1", Some("r1"), RequestKind::Approval)]);
    assert_eq!(outcome, RunOutcome::Interrupted);
    assert_eq!(card.status, ThreadStatus::Idle);
    assert!(card.needs_you.is_none());
}

#[test]
fn settlement_happens_once_and_held_inputs_survive_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("s", "/w"))
            .unwrap();
        store
            .append(&t, vec![input("i1", "x"), started("r1", &["i1"])])
            .unwrap();
        testing::crash(store);
    }
    let len_after_first = {
        let (_, report) = open(dir.path());
        assert_eq!(report.settled.len(), 1);
        log_text(dir.path(), "t").len()
    };
    {
        let (store, report) = open(dir.path());
        assert!(report.settled.is_empty());
        assert_eq!(log_text(dir.path(), "t").len(), len_after_first);
        store
            .append(&t, vec![resolved("resend:r1", RequestOutcome::Resend)])
            .unwrap();
    }
    let (store, _) = open(dir.path());
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.status, ThreadStatus::Queued);
    let fold = replay(dir.path(), "t").1;
    assert_eq!(fold.queued_inputs.len(), 1);
    assert_eq!(fold.queued_inputs[0].input_id.as_str(), "i1");
}

fn thread_with_lines(dir: &std::path::Path) -> ThreadId {
    let t = tid("t");
    let (store, _) = open(dir);
    store
        .create_thread(Some(t.clone()), created("tail", "/w"))
        .unwrap();
    store
        .append(&t, vec![renamed("one"), renamed("two")])
        .unwrap();
    t
}

fn mark_dirty_and_reopen(
    dir: &std::path::Path,
) -> (goat2_thread_store::Store, goat2_thread_store::StartupReport) {
    // Make the row dirty the way a crash mid-append would, then reopen.
    let (store, _) = open(dir);
    store
        .append(&tid("t"), vec![input("d", "dirty"), started("rd", &["d"])])
        .unwrap();
    testing::crash(store);
    open(dir)
}

#[test]
fn an_unterminated_partial_line_is_cut_and_saved() {
    let dir = tempfile::tempdir().unwrap();
    let t = thread_with_lines(dir.path());
    append_raw(dir.path(), "t", br#"{"v":1,"seq":4,"at":"2026-11-2"#);
    let (store, _) = open(dir.path());
    let card = store.append(&t, vec![renamed("three")]).unwrap().card;
    assert_eq!(card.applied_seq, 4);
    let torn = std::fs::read(dir.path().join("threads/t/goat.jsonl.torn-1")).unwrap();
    assert!(torn.starts_with(br#"{"v":1,"seq":4"#));
    assert!(
        log_text(dir.path(), "t")
            .lines()
            .all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok())
    );
}

#[test]
fn a_zero_filled_tail_is_cut() {
    let dir = tempfile::tempdir().unwrap();
    thread_with_lines(dir.path());
    append_raw(dir.path(), "t", &[0u8; 4096]);
    let (_store, report) = mark_dirty_and_reopen(dir.path());
    let _ = report;
    let text = log_text(dir.path(), "t");
    assert!(!text.contains('\0'));
    assert!(
        text.lines()
            .all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok())
    );
}

#[test]
fn a_complete_last_line_without_newline_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let t = thread_with_lines(dir.path());
    append_raw(
        dir.path(),
        "t",
        br#"{"v":1,"seq":4,"at":"2026-11-28T10:00:00Z","type":"thread.changed","title":"kept"}"#,
    );
    let (store, _) = open(dir.path());
    assert_eq!(store.card(&t).unwrap().unwrap().title, "kept");
    assert!(log_text(dir.path(), "t").ends_with("\"kept\"}\n"));
}

#[test]
fn a_complete_malformed_line_fails_closed_and_is_not_touched() {
    let dir = tempfile::tempdir().unwrap();
    let t = thread_with_lines(dir.path());
    append_raw(
        dir.path(),
        "t",
        b"{\"v\":1,\"seq\":4,\"type\":\"thread.changed\",\"title\":5}\n",
    );
    let before = std::fs::read(log_path(dir.path(), "t")).unwrap();
    let (store, _) = open(dir.path());
    assert!(matches!(
        store.append(&t, vec![renamed("x")]),
        Err(StoreError::CorruptLog { .. })
    ));
    assert!(matches!(
        store.read(&t, None),
        Err(StoreError::CorruptLog { .. })
    ));
    assert_eq!(std::fs::read(log_path(dir.path(), "t")).unwrap(), before);
}

#[test]
fn a_seq_gap_is_corruption() {
    let dir = tempfile::tempdir().unwrap();
    let t = thread_with_lines(dir.path());
    append_raw(
        dir.path(),
        "t",
        b"{\"v\":1,\"seq\":9,\"at\":\"2026-11-28T10:00:00Z\",\"type\":\"thread.changed\",\"title\":\"gap\"}\n",
    );
    let (store, _) = open(dir.path());
    assert!(matches!(store.card(&t), Err(StoreError::CorruptLog { .. })));
}

#[test]
fn incomplete_creates_are_abandoned_at_every_step() {
    for step in 1..=4u8 {
        let dir = tempfile::tempdir().unwrap();
        {
            let (store, _) = open(dir.path());
            let id = tid(&format!("c{step}"));
            assert!(
                testing::create_thread_stopping_after(&store, id, created("x", "/w"), step)
                    .is_err()
            );
            testing::crash(store);
        }
        let (store, report) = open(dir.path());
        if step == 4 {
            // The log is complete: the create is finished at startup instead of abandoned.
            assert!(store.card(&tid("c4")).unwrap().is_some(), "step 4");
        } else {
            assert_eq!(
                report.abandoned_creates,
                vec![format!("c{step}")],
                "step {step}"
            );
            assert!(
                !dir.path().join(format!("threads/c{step}")).exists(),
                "step {step}"
            );
            assert_eq!(report.threads, 0);
        }
    }
}

#[test]
fn the_same_damage_on_an_existing_thread_is_corruption_not_abandonment() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("keep me", "/w"))
            .unwrap();
        store
            .append(&t, vec![input("i1", "x"), started("r1", &["i1"])])
            .unwrap();
        testing::crash(store);
    }
    std::fs::write(log_path(dir.path(), "t"), b"{\"v\":1,\"epo").unwrap();
    let (store, report) = open(dir.path());
    assert!(report.abandoned_creates.is_empty());
    assert_eq!(report.corrupt.len(), 1);
    assert!(dir.path().join("threads/t").exists());
    assert_eq!(store.find(&Default::default()).len(), 1, "card kept");
    assert!(matches!(
        store.append(&t, vec![renamed("x")]),
        Err(StoreError::CorruptLog { .. })
    ));
}

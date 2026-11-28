mod common;

use common::*;
use goat2_thread_store::StoreError;
use goat2_thread_store::contract::*;

#[test]
fn a_late_item_after_its_run_finished_is_kept_but_does_not_replace_a_newer_answer() {
    // Background subagents can finish after their run (lane E R3): the host appends the item
    // with its origin run id after that run's run.finished.
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("late", "/w"))
        .unwrap();
    store.append(&t, full_run("r1", "i1", "first")).unwrap();
    let out = store.append(&t, full_run("r2", "i2", "second")).unwrap();
    let excerpt = out.card.latest_answer_excerpt.clone();
    assert!(excerpt.contains("second"), "{excerpt}");
    let items_before = replay(dir.path(), "t").1.counters.items;
    let out = store
        .append(&t, vec![answer("r1", "late", "late answer from r1")])
        .unwrap();
    assert_eq!(out.lines[0].event.type_tag(), "item.completed");
    assert_eq!(out.card.status, ThreadStatus::Idle);
    assert_eq!(
        out.card.latest_answer_excerpt, excerpt,
        "a late item replaced the newer answer"
    );
    let (card, fold) = replay(dir.path(), "t");
    assert_eq!(fold.counters.items, items_before + 1);
    assert_eq!(card.latest_answer_excerpt, excerpt);
    // A late r1 item while r3 runs (not yet accepted by the engine) leaves the excerpt alone and
    // is not evidence that r3 reached the engine: r3 still settles as unknown with a resend hold.
    store
        .append(&t, vec![input("i3", "third"), started("r3", &["i3"])])
        .unwrap();
    let out = store
        .append(&t, vec![answer("r1", "late2", "another late r1 answer")])
        .unwrap();
    assert_eq!(out.card.status, ThreadStatus::Running);
    assert_eq!(out.card.latest_answer_excerpt, excerpt);
    assert!(!out.fold.active_run_reached_engine);
    drop(store);
    let (store, report) = open(dir.path());
    assert_eq!(report.settled.len(), 1);
    assert_eq!(report.settled[0].outcome, RunOutcome::Unknown);
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.needs_you.unwrap().kind, RequestKind::Resend);
    assert_eq!(card.latest_answer_excerpt, excerpt);
}

#[test]
fn append_assigns_seq_after_the_header_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let card = store
        .create_thread(Some(tid("t1")), created("first", "/w"))
        .unwrap();
    assert_eq!(card.applied_seq, 1);
    let out = store
        .append(&tid("t1"), vec![input("i1", "hi"), renamed("second")])
        .unwrap();
    assert_eq!(
        out.lines.iter().map(|l| l.seq).collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert_eq!(out.card.applied_seq, 3);
    let text = log_text(dir.path(), "t1");
    let mut lines = text.lines();
    let header: LogHeader = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(header.v, 1);
    assert_eq!(header.epoch, out.card.epoch);
    let seqs: Vec<u64> = lines
        .map(|l| serde_json::from_str::<LogLine>(l).unwrap().seq)
        .collect();
    assert_eq!(seqs, vec![1, 2, 3]);
}

#[test]
fn every_event_type_is_written_and_reencodes_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let parent = store
        .create_thread(Some(tid("p")), created("parent", "/w"))
        .unwrap();
    store
        .create_thread(Some(tid("c")), child_created("child", "p"))
        .unwrap();
    let p = tid("p");
    store
        .append(&p, vec![input("i1", "one"), input("i2", "two")])
        .unwrap();
    store
        .append(
            &p,
            vec![LogEvent::InputChanged(InputChanged {
                input_id: InputId::new("i2"),
                text: Some("two edited".into()),
                mode: None,
                cancelled: None,
                position: Some(0),
            })],
        )
        .unwrap();
    store
        .append(
            &p,
            vec![
                started("r1", &["i1"]),
                accepted("r1"),
                delivered("i1", "r1", DeliveredAs::Turn, DeliveryOutcome::Accepted),
                request("q1", Some("r1"), RequestKind::Approval),
                resolved("q1", RequestOutcome::Accept),
                child_started("c"),
                answer("r1", "a1", "done"),
                child_reported("c", &parent.epoch),
                notified("result"),
                finished("r1", RunOutcome::Completed),
            ],
        )
        .unwrap();
    let text = log_text(dir.path(), "p");
    let mut tags = std::collections::BTreeSet::new();
    for raw in text.lines().skip(1) {
        let line: LogLine = serde_json::from_str(raw).unwrap();
        tags.insert(line.event.type_tag());
        assert_eq!(
            serde_json::to_string(&line).unwrap(),
            raw,
            "re-encode differs"
        );
    }
    store.append(&p, vec![renamed("renamed")]).unwrap();
    tags.insert("thread.changed");
    assert_eq!(tags.len(), LogEvent::TYPE_TAGS.len(), "{tags:?}");
}

#[test]
fn status_follows_the_precedence_order() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    let status = |s: &goat2_thread_store::Store| s.card(&t).unwrap().unwrap().status;
    assert_eq!(status(&store), ThreadStatus::Idle);
    store.append(&t, vec![input("i1", "x")]).unwrap();
    assert_eq!(status(&store), ThreadStatus::Queued);
    store.append(&t, vec![started("r1", &["i1"])]).unwrap();
    assert_eq!(status(&store), ThreadStatus::Running);
    store
        .append(&t, vec![request("q", Some("r1"), RequestKind::Question)])
        .unwrap();
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.status, ThreadStatus::NeedsYou);
    assert_eq!(card.needs_you.unwrap().kind, RequestKind::Question);
    store
        .append(&t, vec![resolved("q", RequestOutcome::Answered)])
        .unwrap();
    assert_eq!(status(&store), ThreadStatus::Running);
    store
        .append(&t, vec![accepted("r1"), finished("r1", RunOutcome::Failed)])
        .unwrap();
    assert_eq!(status(&store), ThreadStatus::Failed);
    store.append(&t, vec![input("i2", "again")]).unwrap();
    assert_eq!(status(&store), ThreadStatus::Queued);
    store
        .append(
            &t,
            vec![
                started("r2", &["i2"]),
                delivered("i2", "r2", DeliveredAs::Turn, DeliveryOutcome::Accepted),
                finished("r2", RunOutcome::Completed),
            ],
        )
        .unwrap();
    assert_eq!(status(&store), ThreadStatus::Idle);
    let (replayed, _) = replay(dir.path(), "t");
    assert!(same_card(&store.card(&t).unwrap().unwrap(), &replayed));
}

#[test]
fn delivery_rules_keep_each_input_in_exactly_one_place() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("d", "/w"))
        .unwrap();
    store
        .append(&t, vec![input("a", "a"), input("b", "b"), input("c", "c")])
        .unwrap();
    // a: accepted as a turn, b: steer declined (stays queued), c: steer delivery unknown (held).
    let out = store
        .append(
            &t,
            vec![
                started("r1", &["a"]),
                delivered("a", "r1", DeliveredAs::Turn, DeliveryOutcome::Accepted),
                delivered("b", "r1", DeliveredAs::Steer, DeliveryOutcome::Declined),
                delivered("c", "r1", DeliveredAs::Steer, DeliveryOutcome::Unknown),
                finished("r1", RunOutcome::Completed),
            ],
        )
        .unwrap();
    let fold = &replay(dir.path(), "t").1;
    let queued: Vec<&str> = fold
        .queued_inputs
        .iter()
        .map(|q| q.input_id.as_str())
        .collect();
    assert_eq!(queued, vec!["b"]);
    assert_eq!(fold.held_inputs.len(), 1);
    assert_eq!(fold.held_inputs[0].request_id.as_str(), "resend:r1");
    assert_eq!(fold.held_inputs[0].inputs[0].input_id.as_str(), "c");
    assert_eq!(out.card.status, ThreadStatus::NeedsYou);
    assert_eq!(
        out.card.needs_you.as_ref().unwrap().kind,
        RequestKind::Resend
    );
    // Resend puts the held input back at the front of the queue.
    let out = store
        .append(&t, vec![resolved("resend:r1", RequestOutcome::Resend)])
        .unwrap();
    let fold = replay(dir.path(), "t").1;
    let queued: Vec<&str> = fold
        .queued_inputs
        .iter()
        .map(|q| q.input_id.as_str())
        .collect();
    assert_eq!(queued, vec!["c", "b"]);
    assert!(fold.held_inputs.is_empty());
    assert_eq!(out.card.status, ThreadStatus::Queued);
    // A run that never reached the engine and ends unknown holds its inputs; dropping discards them.
    store
        .append(
            &t,
            vec![started("r2", &["c"]), finished("r2", RunOutcome::Unknown)],
        )
        .unwrap();
    let fold = replay(dir.path(), "t").1;
    assert_eq!(fold.held_inputs[0].inputs[0].input_id.as_str(), "c");
    assert_eq!(
        fold.queued_inputs
            .iter()
            .map(|q| q.input_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b"]
    );
    store
        .append(&t, vec![resolved("resend:r2", RequestOutcome::Dropped)])
        .unwrap();
    let fold = replay(dir.path(), "t").1;
    assert!(fold.held_inputs.is_empty());
    assert_eq!(fold.queued_inputs.len(), 1);
}

#[test]
fn only_turn_deliveries_count_as_reaching_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("e", "/w"))
        .unwrap();
    store
        .append(
            &t,
            vec![
                input("i1", "x"),
                input("s1", "steer"),
                started("r1", &["i1"]),
                delivered("s1", "r1", DeliveredAs::Steer, DeliveryOutcome::Accepted),
            ],
        )
        .unwrap();
    assert!(!replay(dir.path(), "t").1.active_run_reached_engine);
    store
        .append(
            &t,
            vec![delivered(
                "i1",
                "r1",
                DeliveredAs::Turn,
                DeliveryOutcome::Accepted,
            )],
        )
        .unwrap();
    assert!(replay(dir.path(), "t").1.active_run_reached_engine);
}

#[test]
fn child_starts_are_checked_and_counted_once_while_running() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let p = tid("p");
    let parent = store
        .create_thread(Some(p.clone()), created("p", "/w"))
        .unwrap();
    store
        .create_thread(Some(tid("c1")), child_created("c1", "p"))
        .unwrap();
    store
        .create_thread(Some(tid("other")), created("o", "/w"))
        .unwrap();
    store.append(&p, vec![child_started("c1")]).unwrap();
    assert!(matches!(
        store.append(&p, vec![child_started("c1")]),
        Err(StoreError::InvalidEvent(_))
    ));
    assert!(matches!(
        store.append(&p, vec![child_started("other")]),
        Err(StoreError::InvalidEvent(_))
    ));
    assert!(matches!(
        store.append(&p, vec![child_started("missing")]),
        Err(StoreError::InvalidEvent(_))
    ));
    let card = store
        .append(&p, vec![child_reported("c1", &parent.epoch)])
        .unwrap()
        .card;
    assert_eq!((card.children.running, card.children.total), (0, 1));
    // Documented residual: a second start of a reported child with a valid parent link is the
    // host's bug (one start per child); the store counts it again.
    let card = store.append(&p, vec![child_started("c1")]).unwrap().card;
    assert_eq!((card.children.running, card.children.total), (1, 2));
}

#[test]
fn run_finished_is_followed_by_a_checkpoint_of_the_folded_state() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("c", "/w"))
        .unwrap();
    let out = store.append(&t, full_run("r1", "i1", "hello")).unwrap();
    let last = out.lines.last().unwrap();
    let LogEvent::Checkpoint(cp) = &last.event else {
        panic!("last line is {}", last.event.type_tag())
    };
    assert_eq!(cp.card.applied_seq, last.seq);
    let (card, fold) = replay(dir.path(), "t");
    assert_eq!(cp.fold, fold);
    assert!(same_card(&cp.card, &card));
    assert_eq!(card.latest_answer_excerpt, "answer to hello");
}

#[test]
fn unknown_event_types_are_skipped_and_newer_versions_stop_the_thread() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("u", "/w"))
            .unwrap();
        store.append(&t, vec![renamed("before")]).unwrap();
    }
    append_raw(
        dir.path(),
        "t",
        br#"{"v":1,"seq":3,"at":"2026-11-28T10:00:00Z","type":"future.event","x":1}
"#,
    );
    {
        let (store, _) = open(dir.path());
        let card = store.append(&t, vec![renamed("after")]).unwrap().card;
        assert_eq!(card.applied_seq, 4);
        assert_eq!(card.title, "after");
        let read = store.read(&t, None).unwrap();
        assert!(
            read.lines.iter().all(|l| l.seq != 3),
            "skipped line is not a LogLine"
        );
        let raw = store.read_raw(&t, 2, 10).unwrap();
        assert!(raw[0].contains("future.event"));
    }
    append_raw(
        dir.path(),
        "t",
        br#"{"v":2,"seq":5,"at":"2026-11-28T10:00:00Z","type":"thread.changed"}
"#,
    );
    let (store, _) = open(dir.path());
    assert!(matches!(
        store.append(&t, vec![renamed("x")]),
        Err(StoreError::UnsupportedEvent { seq: 5, v: 2, .. })
    ));
    assert!(matches!(
        store.read(&t, None),
        Err(StoreError::UnsupportedEvent { .. })
    ));
    assert_eq!(store.read_raw(&t, 4, 10).unwrap().len(), 1);
}

#[test]
fn oversized_input_text_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("big", "/w"))
        .unwrap();
    let big = "x".repeat(BLOB_THRESHOLD_BYTES + 1);
    assert!(matches!(
        store.append(&t, vec![input("i1", &big)]),
        Err(StoreError::PayloadTooLarge(_))
    ));
    assert_eq!(store.card(&t).unwrap().unwrap().applied_seq, 1);
}

#[test]
fn invalid_thread_ids_and_duplicates_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    for bad in ["", ".hidden", "a/b", "../x", "mcp:x"] {
        assert!(matches!(
            store.create_thread(Some(tid(bad)), created("x", "/w")),
            Err(StoreError::InvalidThreadId(_))
        ));
    }
    store
        .create_thread(Some(tid("ok")), created("x", "/w"))
        .unwrap();
    assert!(matches!(
        store.create_thread(Some(tid("ok")), created("x", "/w")),
        Err(StoreError::ThreadExists(_))
    ));
}

#[test]
fn open_asks_counts_requests_for_a_person_and_not_resend_holds() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    let card = store
        .create_thread(Some(t.clone()), created("asks", "/w"))
        .unwrap();
    assert_eq!(card.open_asks, 0);
    assert!(!card.unread);
    let out = store
        .append(
            &t,
            vec![
                input("i1", "x"),
                started("r1", &["i1"]),
                accepted("r1"),
                request("q1", Some("r1"), RequestKind::Approval),
                request("q2", Some("r1"), RequestKind::Question),
            ],
        )
        .unwrap();
    assert_eq!(out.card.open_asks, 2);
    let out = store
        .append(&t, vec![resolved("q1", RequestOutcome::Accept)])
        .unwrap();
    assert_eq!(out.card.open_asks, 1);
    // A run that ends unknown opens the store's own resend hold: it blocks the thread
    // (needs_you) but is not a question for a person.
    let out = store
        .append(
            &t,
            vec![
                resolved("q2", RequestOutcome::Answered),
                finished("r1", RunOutcome::Completed),
                input("i2", "y"),
                started("r2", &["i2"]),
                finished("r2", RunOutcome::Unknown),
            ],
        )
        .unwrap();
    assert_eq!(out.card.status, ThreadStatus::NeedsYou);
    assert_eq!(out.card.open_asks, 0);
    // The count survives a restart and matches a full replay of the log.
    drop(store);
    let (store, _) = open(dir.path());
    assert_eq!(store.card(&t).unwrap().unwrap().open_asks, 0);
    assert_eq!(replay(dir.path(), "t").0.open_asks, 0);
}

#[test]
fn usage_fold_agrees_with_replay_and_checkpoint_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let id = tid("usage");
    store
        .create_thread(Some(id.clone()), created("usage", "/w"))
        .unwrap();
    let usage: Box<ThreadTokenUsageSnapshot> =
        Box::new(serde_json::from_value(serde_json::json!({"usedTokens": 23})).unwrap());
    let mut run = full_run("r1", "i1", "one");
    if let LogEvent::RunFinished(end) = run.last_mut().unwrap() {
        end.token_usage = Some(usage.clone());
    } else {
        panic!("expected run finished");
    }
    let first = store.append(&id, run).unwrap();
    assert_eq!(first.card.context_usage, Some(usage.clone()));
    let second = store.append(&id, full_run("r2", "i2", "two")).unwrap();
    assert_eq!(second.card.context_usage, Some(usage.clone()));
    assert_eq!(
        replay(dir.path(), "usage").0.context_usage,
        Some(usage.clone())
    );
    drop(store);
    let (store, _) = open(dir.path());
    assert_eq!(store.card(&id).unwrap().unwrap().context_usage, Some(usage));
}

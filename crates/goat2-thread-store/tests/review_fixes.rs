//! Review round 1 findings (goat2-ts-code-review-1), each written to fail before its fix.

mod common;

use common::*;
use goat2_thread_store::contract::*;
use goat2_thread_store::{Faults, IndexOutcome, Store, StoreError, StoreOptions, testing};

fn open_with(
    dir: &std::path::Path,
    faults: Faults,
) -> goat2_thread_store::Result<(Store, goat2_thread_store::StartupReport)> {
    Store::open(
        dir,
        StoreOptions {
            faults,
            ..Default::default()
        },
    )
}

// (1) A failed log fsync must not be reported as a successful append.
#[test]
fn a_failed_log_sync_fails_the_append_and_poisons_the_thread() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("before", "/w"))
            .unwrap();
        let (_, rx) = store.subscribe_thread(&t, None).unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_log_syncs: true,
                ..Default::default()
            },
        );
        // Outside a run: written through, so the log must be synced before success.
        let out = store.append(&t, vec![renamed("after")]);
        assert!(matches!(out, Err(StoreError::Io(_))), "{out:?}");
        assert!(
            rx.try_recv().is_err(),
            "nothing published before a durable write"
        );
        testing::set_faults(&store, Faults::default());
        assert!(matches!(
            store.append(&t, vec![renamed("again")]),
            Err(StoreError::Poisoned { .. })
        ));
        let card = store.find(&Default::default()).pop().unwrap();
        assert_eq!(
            card.title, "before",
            "the card list does not show the unsynced change"
        );
        testing::crash(store);
    }
    // The outcome was uncertain: reopening inspects the actual tail.
    let (store, _) = open(dir.path());
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.applied_seq, 2);
    assert_eq!(card.title, "after");
}

#[test]
fn a_failed_sync_of_a_send_boundary_fails_the_append() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    store.append(&t, vec![input("i1", "x")]).unwrap();
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    assert!(store.append(&t, vec![started("r1", &["i1"])]).is_err());
}

#[test]
fn flush_reports_a_failed_log_sync() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("f", "/w"))
        .unwrap();
    store
        .append(
            &t,
            vec![input("i1", "x"), started("r1", &["i1"]), accepted("r1")],
        )
        .unwrap();
    // In-run lines are synced by append itself; a failed sync poisons the thread there.
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    assert!(
        store
            .append(&t, vec![answer("r1", "a1", "partial")])
            .is_err()
    );
    assert!(store.flush().is_err());
}

// (2) An interrupted rebuild must not publish an incomplete index.
#[test]
fn an_interrupted_rebuild_is_redone_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        for i in 0..3 {
            store
                .create_thread(Some(tid(&format!("t{i}"))), created("x", "/w"))
                .unwrap();
        }
    }
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    assert!(
        open_with(
            dir.path(),
            Faults {
                stop_rebuild_before_rows: true,
                ..Default::default()
            }
        )
        .is_err()
    );
    let (store, report) = open(dir.path());
    assert!(
        matches!(&report.index, IndexOutcome::Rebuilt { .. }),
        "{:?}",
        report.index
    );
    assert_eq!(report.threads, 3);
    assert!(store.index_complete());
    drop(store);
    let (_, report) = open(dir.path());
    assert!(matches!(report.index, IndexOutcome::Loaded));
}

#[test]
fn a_folder_that_cannot_be_indexed_leaves_the_index_marked_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        for id in ["a", "b", "c"] {
            store
                .create_thread(Some(tid(id)), created(id, "/w"))
                .unwrap();
        }
    }
    // b: complete but invalid header line.
    std::fs::write(
        log_path(dir.path(), "b"),
        b"{\"v\":1,\"epoch\":5}\n{\"v\":1}\n",
    )
    .unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, report) = open(dir.path());
    assert!(!store.index_complete());
    assert_eq!(report.threads, 2);
    assert!(
        report.unindexed.iter().any(|p| p.thread_id == "b"),
        "{:?}",
        report.unindexed
    );
    assert!(
        dir.path().join("threads/b/goat.jsonl").exists(),
        "corrupt folder preserved"
    );
    drop(store);
    let (store, report) = open(dir.path());
    assert!(
        matches!(report.index, IndexOutcome::Rebuilt { .. }),
        "rebuilt again: {:?}",
        report.index
    );
    assert!(!store.index_complete());
}

#[test]
fn a_failed_sync_during_rebuild_fails_open_and_the_next_start_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("a")), created("a", "/w"))
            .unwrap();
    }
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    assert!(
        open_with(
            dir.path(),
            Faults {
                fail_log_syncs: true,
                ..Default::default()
            }
        )
        .is_err()
    );
    let (store, report) = open(dir.path());
    assert!(matches!(report.index, IndexOutcome::Rebuilt { .. }));
    assert!(store.card(&tid("a")).unwrap().is_some());
}

#[test]
fn rebuild_repairs_the_tail_before_replaying_a_thread_without_card_json() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("a")), created("a", "/w"))
            .unwrap();
        store.append(&tid("a"), vec![renamed("kept")]).unwrap();
    }
    append_raw(dir.path(), "a", br#"{"v":1,"seq":3,"at":"2026-11"#);
    std::fs::remove_file(dir.path().join("threads/a/card.json")).unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, report) = open(dir.path());
    assert!(store.index_complete(), "{:?}", report.unindexed);
    assert_eq!(store.card(&tid("a")).unwrap().unwrap().title, "kept");
}

#[test]
fn rebuild_folds_a_stale_card_json_forward() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("a")), created("a", "/w"))
            .unwrap();
    }
    let stale = std::fs::read(dir.path().join("threads/a/card.json")).unwrap();
    {
        let (store, _) = open(dir.path());
        store.append(&tid("a"), vec![renamed("newer")]).unwrap();
    }
    std::fs::write(dir.path().join("threads/a/card.json"), stale).unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, _) = open(dir.path());
    let (card, _) = replay(dir.path(), "a");
    assert!(same_card(&store.card(&tid("a")).unwrap().unwrap(), &card));
}

// (3) A transient I/O error at startup must not abandon a finished create.
#[test]
fn an_io_error_while_checking_a_creating_row_keeps_the_thread() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        let _ = testing::create_thread_stopping_after(&store, tid("c"), created("c", "/w"), 4);
        testing::crash(store);
    }
    assert!(matches!(
        open_with(
            dir.path(),
            Faults {
                fail_log_reads: true,
                ..Default::default()
            }
        ),
        Err(StoreError::Io(_))
    ));
    assert!(
        dir.path().join("threads/c/goat.jsonl").exists(),
        "folder kept after an I/O error"
    );
    let (store, report) = open(dir.path());
    assert!(report.abandoned_creates.is_empty());
    assert!(
        store.card(&tid("c")).unwrap().is_some(),
        "the finished create is kept"
    );
}

#[test]
fn a_complete_but_invalid_first_line_of_a_creating_row_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        let _ = testing::create_thread_stopping_after(&store, tid("c"), created("c", "/w"), 4);
        testing::crash(store);
    }
    let text = log_text(dir.path(), "c");
    let header = text.lines().next().unwrap();
    std::fs::write(
        log_path(dir.path(), "c"),
        format!("{header}\n{{\"v\":1,\"seq\":1,\"type\":\"thread.created\"}}\n"),
    )
    .unwrap();
    let (_store, report) = open(dir.path());
    assert!(report.abandoned_creates.is_empty());
    assert_eq!(report.corrupt.len(), 1);
    assert!(dir.path().join("threads/c/goat.jsonl").exists());
}

// (4) Tail repair must not cut a complete invalid unterminated line.
fn tail_case(
    bytes: &[u8],
) -> (
    goat2_thread_store::Result<Option<ThreadCard>>,
    Vec<u8>,
    Vec<u8>,
) {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("t")), created("t", "/w"))
            .unwrap();
        store.append(&tid("t"), vec![renamed("one")]).unwrap();
    }
    append_raw(dir.path(), "t", bytes);
    let before = std::fs::read(log_path(dir.path(), "t")).unwrap();
    let (store, _) = open(dir.path());
    let card = store.card(&tid("t"));
    let after = std::fs::read(log_path(dir.path(), "t")).unwrap();
    (card, before, after)
}

#[test]
fn an_unterminated_complete_line_with_a_seq_gap_is_corruption() {
    let (card, before, after) = tail_case(
        br#"{"v":1,"seq":9,"at":"2026-11-28T10:00:00Z","type":"thread.changed","title":"gap"}"#,
    );
    assert!(
        matches!(card, Err(StoreError::CorruptLog { .. })),
        "{card:?}"
    );
    assert_eq!(before, after);
}

#[test]
fn an_unterminated_complete_line_with_invalid_fields_is_corruption() {
    let (card, before, after) = tail_case(
        br#"{"v":1,"seq":3,"at":"2026-11-28T10:00:00Z","type":"thread.changed","title":7}"#,
    );
    assert!(
        matches!(card, Err(StoreError::CorruptLog { .. })),
        "{card:?}"
    );
    assert_eq!(before, after);
}

#[test]
fn an_unterminated_non_eof_syntax_error_is_corruption() {
    let (card, before, after) = tail_case(br#"{"v":1,"seq":3,]garbage"#);
    assert!(
        matches!(card, Err(StoreError::CorruptLog { .. })),
        "{card:?}"
    );
    assert_eq!(before, after);
}

#[test]
fn an_unterminated_line_of_a_newer_version_is_completed_and_stops_the_thread() {
    let (card, _, after) =
        tail_case(br#"{"v":2,"seq":3,"at":"2026-11-28T10:00:00Z","type":"thread.changed"}"#);
    assert!(
        matches!(card, Err(StoreError::UnsupportedEvent { seq: 3, .. })),
        "{card:?}"
    );
    assert!(after.ends_with(b"}\n"));
}

// Review round 2: a committed create whose first line is longer than any fixed probe window.
#[test]
fn a_committed_create_with_a_huge_first_line_is_kept_after_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        let _ = testing::create_thread_stopping_after(&store, tid("c"), created("c", "/w"), 4);
        testing::crash(store);
    }
    // Rewrite the first event with a 2 MiB title, as an older or other writer could have.
    let text = log_text(dir.path(), "c");
    let mut lines = text.lines();
    let header = lines.next().unwrap();
    let mut first: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    first["title"] = "t".repeat(2 * 1024 * 1024).into();
    std::fs::write(
        log_path(dir.path(), "c"),
        format!("{header}\n{}\n", serde_json::to_string(&first).unwrap()),
    )
    .unwrap();
    let (store, report) = open(dir.path());
    assert!(
        report.abandoned_creates.is_empty(),
        "{:?}",
        report.abandoned_creates
    );
    assert!(dir.path().join("threads/c/goat.jsonl").exists());
    assert!(store.card(&tid("c")).unwrap().is_some());
}

#[test]
fn an_oversized_thread_created_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let big = created("x", &"/w".repeat(40_000));
    assert!(matches!(
        store.create_thread(Some(tid("big")), big),
        Err(StoreError::PayloadTooLarge(_))
    ));
    assert!(!dir.path().join("threads/big").exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_card_json_fails_the_rebuild_instead_of_being_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("a")), created("a", "/w"))
            .unwrap();
    }
    let card = dir.path().join("threads/a/card.json");
    std::fs::set_permissions(&card, std::fs::Permissions::from_mode(0o000)).unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let result = Store::open(dir.path(), StoreOptions::default());
    std::fs::set_permissions(&card, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        matches!(result, Err(StoreError::Io(_))),
        "{:?}",
        result.as_ref().err()
    );
}

#[test]
fn fold_returns_the_current_fold_and_append_returns_it_too() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("f", "/w"))
        .unwrap();
    let out = store
        .append(&t, vec![input("i1", "x"), started("r1", &["i1"])])
        .unwrap();
    let fold = store.fold(&t).unwrap().unwrap();
    assert_eq!(fold, out.fold);
    assert_eq!(fold, replay(dir.path(), "t").1);
    assert_eq!(fold.active_run_id.as_ref().map(|r| r.as_str()), Some("r1"));
    assert!(store.fold(&tid("missing")).unwrap().is_none());
}

// Review round 3.
fn rebuild_with_interior_line(bad: &[u8]) -> (Store, goat2_thread_store::StartupReport) {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("a")), created("a", "/w"))
            .unwrap();
        store.append(&tid("a"), vec![renamed("two")]).unwrap();
    }
    append_raw(dir.path(), "a", bad);
    append_raw(
        dir.path(),
        "a",
        b"{\"v\":1,\"seq\":3,\"at\":\"2026-11-28T10:00:00Z\",\"type\":\"thread.changed\",\"title\":\"three\"}\n",
    );
    std::fs::remove_file(dir.path().join("threads/a/card.json")).unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let opened = open(dir.path());
    std::mem::forget(dir);
    opened
}

#[test]
fn an_interior_empty_line_is_corruption_not_the_end_of_the_log() {
    let (store, report) = rebuild_with_interior_line(b"\n");
    assert!(!store.index_complete(), "{:?}", report.unindexed);
    assert!(report.unindexed.iter().any(|p| p.thread_id == "a"));
    assert!(store.card(&tid("a")).unwrap().is_none());
}

#[test]
fn an_interior_zero_filled_line_is_corruption_not_the_end_of_the_log() {
    let (store, report) = rebuild_with_interior_line(&[0, 0, 0, 0, b'\n']);
    assert!(!store.index_complete(), "{:?}", report.unindexed);
    assert!(store.card(&tid("a")).unwrap().is_none());
}

#[test]
fn a_create_whose_cache_write_fails_announces_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let (_, rx) = store.subscribe_cards(None);
    testing::set_faults(
        &store,
        Faults {
            fail_cache_writes: true,
            ..Default::default()
        },
    );
    assert!(
        store
            .create_thread(Some(tid("g")), created("g", "/w"))
            .is_err()
    );
    assert!(store.find(&Default::default()).is_empty(), "no ghost card");
    assert!(rx.try_recv().is_err(), "nothing announced");
    testing::set_faults(&store, Faults::default());
    testing::crash(store);
    // The log was committed, so the next start finishes the create.
    let (store, _) = open(dir.path());
    assert!(store.card(&tid("g")).unwrap().is_some());
}

// Review round 4.
#[test]
fn repeated_flush_and_close_keep_reporting_a_failed_sync() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("f", "/w"))
        .unwrap();
    store
        .append(
            &t,
            vec![input("i1", "x"), started("r1", &["i1"]), accepted("r1")],
        )
        .unwrap();
    // In-run lines are synced by append itself; a failed sync poisons the thread there.
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    assert!(
        store
            .append(&t, vec![answer("r1", "a1", "partial")])
            .is_err()
    );
    assert!(store.flush().is_err());
    testing::set_faults(&store, Faults::default());
    assert!(
        store.flush().is_err(),
        "second flush still reports the unflushed thread"
    );
    assert!(store.close().is_err(), "close reports it too");
}

#[test]
fn concurrent_creates_are_never_skipped_by_a_card_cursor_and_keep_later_appends() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open(
            dir.path(),
            StoreOptions {
                fsync: false,
                ..Default::default()
            },
        )
        .unwrap()
        .0,
    );
    let done = Arc::new(AtomicBool::new(false));
    // A reader follows the card cursor the whole time.
    let reader = {
        let store = store.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let mut seen = std::collections::HashSet::new();
            let mut cursor = None;
            loop {
                let finished = done.load(Ordering::SeqCst);
                let read = store.cards_after(cursor.as_ref());
                assert!(read.reset.is_none(), "{:?}", read.reset);
                for card in read.cards {
                    seen.insert(card.id.to_string());
                }
                cursor = Some(read.cursor);
                if finished {
                    return seen;
                }
            }
        })
    };
    let writers: Vec<_> = (0..4)
        .map(|w| {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..50 {
                    let id = tid(&format!("w{w}-{i}"));
                    store
                        .create_thread(Some(id.clone()), created("c", "/w"))
                        .unwrap();
                    store.append(&id, vec![renamed("after create")]).unwrap();
                }
            })
        })
        .collect();
    for w in writers {
        w.join().unwrap();
    }
    done.store(true, Ordering::SeqCst);
    let seen = reader.join().unwrap();
    assert_eq!(seen.len(), 200, "a card cursor skipped a created thread");
    for card in store.find(&Default::default()) {
        assert_eq!(card.title, "after create", "{} lost its append", card.id);
    }
}

#[test]
fn a_card_cursor_taken_during_a_create_still_sees_the_new_card() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(open(dir.path()).0);
    store
        .create_thread(Some(tid("before")), created("b", "/w"))
        .unwrap();
    let reached = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    testing::pause_creates_before_announce(&store, Some((reached.clone(), release.clone())));
    let creator = {
        let store = store.clone();
        std::thread::spawn(move || {
            store
                .create_thread(Some(tid("new")), created("n", "/w"))
                .unwrap()
        })
    };
    reached.wait();
    // The create is paused just before its announcement.
    let during = store.cards_after(None);
    assert!(during.cards.iter().all(|c| c.id.as_str() != "new"));
    release.wait();
    creator.join().unwrap();
    testing::pause_creates_before_announce(&store, None);
    let after = store.cards_after(Some(&during.cursor));
    assert!(
        after.cards.iter().any(|c| c.id.as_str() == "new"),
        "resuming from a cursor taken mid-create skipped the new card"
    );
}

#[test]
fn an_append_racing_a_create_is_not_overwritten_by_the_announcement() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(open(dir.path()).0);
    let reached = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    testing::pause_creates_before_announce(&store, Some((reached.clone(), release.clone())));
    let creator = {
        let store = store.clone();
        std::thread::spawn(move || {
            store
                .create_thread(Some(tid("new")), created("old title", "/w"))
                .unwrap()
        })
    };
    reached.wait();
    let appender = {
        let store = store.clone();
        std::thread::spawn(move || store.append(&tid("new"), vec![renamed("appended")]))
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    release.wait();
    creator.join().unwrap();
    appender.join().unwrap().unwrap();
    testing::pause_creates_before_announce(&store, None);
    let card = store.find(&Default::default()).pop().unwrap();
    assert_eq!(
        card.title, "appended",
        "the create's announcement overwrote a newer card"
    );
    assert_eq!(store.cards_after(None).cards[0].title, "appended");
}

// Review round 5.
#[test]
fn an_append_waiting_on_a_deleted_thread_cannot_write_into_a_recreated_one() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(open(dir.path()).0);
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("old", "/w"))
        .unwrap();
    store
        .append(&t, vec![renamed("old 2"), renamed("old 3")])
        .unwrap();
    let b: Vec<Arc<Barrier>> = (0..4).map(|_| Arc::new(Barrier::new(2))).collect();
    testing::pause_deletes(
        &store,
        Some([b[0].clone(), b[1].clone(), b[2].clone(), b[3].clone()]),
    );
    let deleter = {
        let store = store.clone();
        let t = t.clone();
        std::thread::spawn(move || store.delete_thread(&t).unwrap())
    };
    b[0].wait(); // delete holds the thread lock
    let appender = {
        let store = store.clone();
        let t = t.clone();
        std::thread::spawn(move || store.append(&t, vec![renamed("late append")]))
    };
    std::thread::sleep(std::time::Duration::from_millis(50)); // appender is waiting on the old lock
    b[1].wait();
    b[2].wait(); // the old thread is gone from the map, its lock still held
    testing::pause_deletes(&store, None);
    store
        .create_thread(Some(t.clone()), created("new", "/w"))
        .unwrap();
    b[3].wait();
    deleter.join().unwrap();
    let late = appender.join().unwrap();
    assert!(
        matches!(late, Err(StoreError::ThreadMissing(_))),
        "{late:?}"
    );
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!((card.title.as_str(), card.applied_seq), ("new", 1));
    let (replayed, _) = replay(dir.path(), "t");
    assert_eq!(
        replayed.applied_seq, 1,
        "the new thread's log was written by the old slot"
    );
}

#[test]
fn flush_and_close_report_a_thread_poisoned_by_an_unbatched_append() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("p", "/w"))
        .unwrap();
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    assert!(store.append(&t, vec![renamed("x")]).is_err());
    testing::set_faults(&store, Faults::default());
    assert!(store.flush().is_err(), "flush reports the poisoned thread");
    assert!(store.close().is_err());
}

// Review round 6.
fn delete_with_fault(faults: Faults) {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("doomed", "/w"))
            .unwrap();
        let (_, rx) = store.subscribe_cards(None);
        testing::set_faults(&store, faults);
        assert!(
            store.delete_thread(&t).is_err(),
            "the durability error is reported"
        );
        testing::set_faults(&store, Faults::default());
        assert!(store.find(&Default::default()).is_empty(), "no ghost card");
        assert!(store.card(&t).unwrap().is_none());
        assert!(
            rx.try_iter()
                .any(|u| matches!(u, goat2_thread_store::CardUpdate::Removed { .. })),
            "subscribers learn about the removal"
        );
        assert!(matches!(
            store.delete_thread(&t),
            Err(StoreError::ThreadMissing(_))
        ));
        store
            .create_thread(Some(t.clone()), created("reborn", "/w"))
            .unwrap();
        assert_eq!(store.card(&t).unwrap().unwrap().title, "reborn");
        testing::crash(store);
    }
    let (store, _) = open(dir.path());
    assert_eq!(store.card(&t).unwrap().unwrap().title, "reborn");
    assert_eq!(store.find(&Default::default()).len(), 1);
}

#[test]
fn a_delete_whose_directory_sync_fails_leaves_no_ghost_card() {
    delete_with_fault(Faults {
        fail_delete_dir_sync: true,
        ..Default::default()
    });
}

#[test]
fn a_delete_whose_index_delete_fails_leaves_no_ghost_card() {
    delete_with_fault(Faults {
        fail_delete_index: true,
        ..Default::default()
    });
}

#[test]
fn a_delete_whose_index_delete_fails_is_finished_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("t")), created("doomed", "/w"))
            .unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_delete_index: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&tid("t")).is_err());
        testing::crash(store);
    }
    let (store, report) = open(dir.path());
    assert_eq!(report.removed_deleted, vec!["t"]);
    assert!(store.find(&Default::default()).is_empty());
}

// Review round 7.
#[test]
fn a_delete_whose_rename_was_not_synced_keeps_the_row_for_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    let thread_dir = dir.path().join("threads/t");
    let backup = dir.path().join("rollback-copy");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("survivor", "/w"))
            .unwrap();
        store.append(&t, vec![renamed("survivor 2")]).unwrap();
        std::fs::create_dir(&backup).unwrap();
        for name in ["goat.jsonl", "card.json"] {
            std::fs::copy(thread_dir.join(name), backup.join(name)).unwrap();
        }
        testing::set_faults(
            &store,
            Faults {
                fail_delete_dir_sync: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&t).is_err());
        testing::crash(store);
    }
    // Power loss rolled the unsynced rename back: the folder is where it was.
    std::fs::rename(&backup, &thread_dir).unwrap();
    let (store, _) = open(dir.path());
    let card = store
        .card(&t)
        .unwrap()
        .expect("the folder is visible again, not hidden");
    assert_eq!(card.title, "survivor 2");
}

#[test]
fn an_interrupted_recreation_after_a_failed_index_delete_shows_no_old_card() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("old", "/w"))
            .unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_delete_index: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&t).is_err());
        testing::set_faults(&store, Faults::default());
        // Recreate the id and stop right after mkdir.
        assert!(
            testing::create_thread_stopping_after(&store, t.clone(), created("new", "/w"), 2)
                .is_err()
        );
        testing::crash(store);
    }
    let (store, report) = open(dir.path());
    assert_eq!(report.abandoned_creates, vec!["t"]);
    assert!(
        store.find(&Default::default()).is_empty(),
        "the old card came back"
    );
    assert!(report.corrupt.is_empty(), "{:?}", report.corrupt);
}

// Review round 8.
fn trash_dirs(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir.join("threads"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.starts_with(".trash-"))
        .collect()
}

#[test]
fn a_delete_whose_rename_was_not_synced_keeps_the_trash_contents() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    store
        .create_thread(Some(tid("t")), created("keep", "/w"))
        .unwrap();
    testing::set_faults(
        &store,
        Faults {
            fail_delete_dir_sync: true,
            ..Default::default()
        },
    );
    assert!(store.delete_thread(&tid("t")).is_err());
    let trash = trash_dirs(dir.path());
    assert_eq!(trash.len(), 1, "trash kept until the rename is durable");
    assert!(
        dir.path()
            .join("threads")
            .join(&trash[0])
            .join("goat.jsonl")
            .exists()
    );
}

#[test]
fn startup_makes_a_rename_durable_before_finishing_the_delete() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("t")), created("keep", "/w"))
            .unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_delete_dir_sync: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&tid("t")).is_err());
        testing::crash(store);
    }
    // The directory still cannot be synced: the delete must not be finished (open fails).
    assert!(
        Store::open(
            dir.path(),
            StoreOptions {
                faults: Faults {
                    fail_delete_dir_sync: true,
                    ..Default::default()
                },
                ..Default::default()
            }
        )
        .is_err()
    );
    let (store, report) = open(dir.path());
    assert_eq!(report.removed_deleted, vec!["t"]);
    assert!(store.find(&Default::default()).is_empty());
    assert!(
        trash_dirs(dir.path()).is_empty(),
        "the thread's trash is cleared once the rename is durable"
    );
}

// Review round 9.
#[test]
fn abandoning_a_create_syncs_the_threads_directory_before_dropping_the_row() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("t")), created("old", "/w"))
            .unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_delete_dir_sync: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&tid("t")).is_err());
        testing::set_faults(&store, Faults::default());
        // Same id recreated; the process dies after the creation intent (step 1).
        assert!(
            testing::create_thread_stopping_after(&store, tid("t"), created("new", "/w"), 1)
                .is_err()
        );
        testing::crash(store);
    }
    // The directory still cannot be synced: the row must not be dropped.
    assert!(
        Store::open(
            dir.path(),
            StoreOptions {
                faults: Faults {
                    fail_delete_dir_sync: true,
                    ..Default::default()
                },
                ..Default::default()
            }
        )
        .is_err()
    );
    assert_eq!(
        trash_dirs(dir.path()).len(),
        1,
        "old trash kept while the rename is not durable"
    );
    let (store, report) = open(dir.path());
    assert_eq!(report.abandoned_creates, vec!["t"]);
    assert!(store.find(&Default::default()).is_empty());
    assert!(trash_dirs(dir.path()).is_empty());
}

// Review round 10.
#[test]
fn an_in_run_line_is_synced_before_any_reader_sees_it() {
    // A reader holding a cursor past lines a power loss later drops would resume with no reset
    // (startup settlement reuses those seqs). So every line is durable before it is published.
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    store
        .append(&t, vec![input("i1", "x"), started("r1", &["i1"])])
        .unwrap();
    let (_, rx) = store.subscribe_thread(&t, None).unwrap();
    while rx.try_recv().is_ok() {}
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    let out = store.append(&t, vec![answer("r1", "a", "partial")]);
    assert!(matches!(out, Err(StoreError::Io(_))), "{out:?}");
    assert!(rx.try_recv().is_err(), "an unsynced line was published");
}

#[test]
fn startup_clears_trash_left_by_a_delete_whose_id_was_recreated() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(tid("t")), created("old", "/w"))
            .unwrap();
        testing::set_faults(
            &store,
            Faults {
                fail_delete_dir_sync: true,
                ..Default::default()
            },
        );
        assert!(store.delete_thread(&tid("t")).is_err());
        testing::set_faults(&store, Faults::default());
        store
            .create_thread(Some(tid("t")), created("new", "/w"))
            .unwrap();
        store.close().unwrap();
    }
    assert_eq!(trash_dirs(dir.path()).len(), 1);
    let (store, _) = open(dir.path());
    assert!(
        trash_dirs(dir.path()).is_empty(),
        "old trash outlived a clean start"
    );
    assert_eq!(store.card(&tid("t")).unwrap().unwrap().title, "new");
}

#[test]
fn racing_creates_of_one_id_lose_with_thread_exists_and_keep_the_cached_card() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let store = std::sync::Arc::new(store);
    for n in 0..40 {
        let id = format!("race{n}");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (store, barrier, id) = (store.clone(), barrier.clone(), id.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    store.create_thread(Some(tid(&id)), created("r", "/w"))
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            results.iter().filter(|r| r.is_ok()).count(),
            1,
            "{results:?}"
        );
        for r in results.iter().filter(|r| r.is_err()) {
            assert!(matches!(r, Err(StoreError::ThreadExists(_))), "{r:?}");
        }
    }
    let store = std::sync::Arc::into_inner(store).unwrap();
    store.close().unwrap();
    // Every winner's row keeps its cached card: a clean start refolds nothing.
    let (_, report) = open(dir.path());
    assert!(report.refolded.is_empty(), "{:?}", report.refolded);
}

// Review round 11 follow-ups.
#[test]
fn read_raw_refuses_a_thread_whose_last_sync_failed() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
    );
    assert!(store.append(&t, vec![renamed("unsynced")]).is_err());
    testing::set_faults(&store, Faults::default());
    let raw = store.read_raw(&t, 0, 10);
    assert!(matches!(raw, Err(StoreError::Poisoned { .. })), "{raw:?}");
}

#[test]
fn only_finished_items_are_appended() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    store
        .append(&t, vec![input("i1", "x"), started("r1", &["i1"])])
        .unwrap();
    let streaming = item(
        "r1",
        "a",
        serde_json::json!({"type": "assistant_message", "messageId": "m-a", "text": "par", "streaming": true}),
    );
    let running = item(
        "r1",
        "b",
        serde_json::json!({"type": "command_execution", "input": "ls", "outputOmitted": true, "status": "running"}),
    );
    for event in [streaming, running] {
        let out = store.append(&t, vec![event]);
        assert!(matches!(out, Err(StoreError::InvalidEvent(_))), "{out:?}");
    }
    store.append(&t, vec![answer("r1", "c", "done")]).unwrap();
    assert_eq!(store.card(&t).unwrap().unwrap().applied_seq, 4);
}

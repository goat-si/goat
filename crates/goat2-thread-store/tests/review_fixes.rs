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
    store
        .append(&t, vec![answer("r1", "a1", "partial")])
        .unwrap();
    testing::set_faults(
        &store,
        Faults {
            fail_log_syncs: true,
            ..Default::default()
        },
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

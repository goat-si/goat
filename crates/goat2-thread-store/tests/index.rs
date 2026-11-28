mod common;

use common::*;
use goat2_thread_store::contract::*;
use goat2_thread_store::{CardFilter, CardUpdate, IndexOutcome, StoreError, testing};

fn populate(store: &goat2_thread_store::Store, n: usize) {
    for i in 0..n {
        let id = format!("t{i}");
        let mut c = created(&id, if i % 2 == 0 { "/even" } else { "/odd" });
        if i == 0 {
            c.bot_id = Some(BotId::new("bot-1"));
            c.kind = ThreadKind::Bot;
        }
        store.create_thread(Some(tid(&id)), c).unwrap();
        store.append(&tid(&id), full_run("r1", "i1", &id)).unwrap();
    }
}

#[test]
fn deleting_the_index_rebuilds_it_from_the_folders() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<ThreadCard> = {
        let (store, _) = open(dir.path());
        populate(&store, 5);
        store.find(&CardFilter::default())
    };
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, report) = open(dir.path());
    assert!(matches!(&report.index, IndexOutcome::Rebuilt { reason } if reason == "missing"));
    assert_eq!(report.threads, 5);
    assert_eq!(report.logs_opened, 5, "rebuild verifies every log's tail");
    for card in before {
        assert!(same_card(&store.card(&card.id).unwrap().unwrap(), &card));
    }
}

#[test]
fn a_garbage_index_file_is_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        populate(&store, 2);
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.path().join(format!("cards.sqlite{suffix}")));
    }
    std::fs::write(dir.path().join("cards.sqlite"), vec![0x5a; 8192]).unwrap();
    let (_store, report) = open(dir.path());
    assert!(
        matches!(&report.index, IndexOutcome::Rebuilt { reason } if reason.starts_with("corrupt")),
        "{:?}",
        report.index
    );
    assert_eq!(report.threads, 2);
}

#[test]
fn find_uses_only_index_fields() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    populate(&store, 4);
    store
        .create_thread(Some(tid("kid")), child_created("kid", "t1"))
        .unwrap();
    store
        .append(
            &tid("t3"),
            vec![LogEvent::ThreadChanged(ThreadChanged {
                archived_at: Some(Some("2026-11-28T10:00:00Z".into())),
                ..Default::default()
            })],
        )
        .unwrap();
    store
        .append(&tid("t2"), vec![input("q", "queued")])
        .unwrap();
    let ids = |f: CardFilter| {
        let mut v: Vec<String> = store
            .find(&f)
            .into_iter()
            .map(|c| c.id.to_string())
            .collect();
        v.sort();
        v
    };
    assert_eq!(
        ids(CardFilter {
            cwd: Some("/even".into()),
            ..Default::default()
        }),
        vec!["t0", "t2"]
    );
    assert_eq!(
        ids(CardFilter {
            parent_thread_id: Some(tid("t1")),
            ..Default::default()
        }),
        vec!["kid"]
    );
    assert_eq!(
        ids(CardFilter {
            status: Some(ThreadStatus::Queued),
            ..Default::default()
        }),
        vec!["t2"]
    );
    assert_eq!(
        ids(CardFilter {
            kind: Some(ThreadKind::Bot),
            ..Default::default()
        }),
        vec!["t0"]
    );
    assert_eq!(
        ids(CardFilter {
            bot_id: Some(BotId::new("bot-1")),
            ..Default::default()
        }),
        vec!["t0"]
    );
    assert_eq!(
        ids(CardFilter {
            archived: Some(true),
            ..Default::default()
        }),
        vec!["t3"]
    );
    assert_eq!(
        ids(CardFilter {
            project_id: Some(ProjectId::new("proj-1")),
            ..Default::default()
        })
        .len(),
        5
    );
}

#[test]
fn cards_after_returns_changes_and_resets() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    populate(&store, 3);
    let first = store.cards_after(None);
    assert_eq!(first.cards.len(), 3);
    assert!(first.reset.is_none());
    let (_, rx) = store.subscribe_cards(Some(&first.cursor));
    store.append(&tid("t1"), vec![renamed("changed")]).unwrap();
    let changed = store.cards_after(Some(&first.cursor));
    assert_eq!(
        changed
            .cards
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        vec!["t1"]
    );
    store.delete_thread(&tid("t2")).unwrap();
    // A cursor from before a deletion resets (structure/30_wire.md: no tombstones in Part 1).
    let next = store.cards_after(Some(&first.cursor));
    assert_eq!(next.reset, Some(ResetReason::ThreadMissing));
    assert_eq!(next.cards.len(), 2);
    let updates: Vec<CardUpdate> = rx.try_iter().collect();
    assert!(
        updates
            .iter()
            .any(|u| matches!(u, CardUpdate::Changed(c) if c.id.as_str() == "t1"))
    );
    assert!(
        updates.iter().any(
            |u| matches!(u, CardUpdate::Removed { thread_id, .. } if thread_id.as_str() == "t2")
        )
    );
    let caught_up = store.cards_after(Some(&next.cursor));
    assert!(caught_up.cards.is_empty() && caught_up.reset.is_none());
    let mut future = next.cursor.clone();
    future.card_seq += 10;
    assert_eq!(
        store.cards_after(Some(&future)).reset,
        Some(ResetReason::InvalidCursor)
    );
    drop(store);
    let (store, _) = open(dir.path());
    let after_restart = store.cards_after(Some(&next.cursor));
    assert_eq!(after_restart.reset, Some(ResetReason::EpochChanged));
    assert_eq!(after_restart.cards.len(), 2);
}

#[test]
fn a_clean_start_opens_no_logs_and_a_crash_opens_only_dirty_or_active_ones() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        populate(&store, 10);
        for id in ["t3", "t7"] {
            store
                .append(
                    &tid(id),
                    vec![input("i9", "x"), started("r9", &["i9"]), accepted("r9")],
                )
                .unwrap();
        }
        // Batched in-run writes are flushed: rows are clean but still mark the active run.
        store.flush().unwrap();
        testing::crash(store);
    }
    let (store, report) = open(dir.path());
    assert_eq!(report.logs_opened, 2);
    let mut settled: Vec<_> = report
        .settled
        .iter()
        .map(|s| (s.thread_id.clone(), s.outcome))
        .collect();
    settled.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        settled,
        vec![
            ("t3".to_string(), RunOutcome::Interrupted),
            ("t7".to_string(), RunOutcome::Interrupted)
        ]
    );
    drop(store);
    let (_, report) = open(dir.path());
    assert_eq!(report.logs_opened, 0);
    assert!(report.settled.is_empty());
}

#[test]
fn a_crash_inside_delete_does_not_bring_the_thread_back() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        populate(&store, 2);
        testing::delete_thread_stopping_after_rename(&store, &tid("t1")).unwrap();
        testing::crash(store);
    }
    {
        let (store, report) = open(dir.path());
        assert_eq!(report.removed_deleted, vec!["t1"]);
        assert!(store.card(&tid("t1")).unwrap().is_none());
    }
    // Same crash, then the index is lost: the rebuild skips and removes the trash folder.
    {
        let (store, _) = open(dir.path());
        testing::delete_thread_stopping_after_rename(&store, &tid("t0")).unwrap();
        testing::crash(store);
    }
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, report) = open(dir.path());
    assert_eq!(report.threads, 0);
    assert!(store.card(&tid("t0")).unwrap().is_none());
    let names: Vec<String> = std::fs::read_dir(dir.path().join("threads"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert!(names.is_empty(), "{names:?}");
}

#[test]
fn a_second_store_on_the_same_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (_store, _) = open(dir.path());
    assert!(matches!(
        goat2_thread_store::Store::open(dir.path(), Default::default()),
        Err(StoreError::Locked)
    ));
}

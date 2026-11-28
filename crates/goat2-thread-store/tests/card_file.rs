mod common;

use common::*;
use goat2_thread_store::contract::*;
use goat2_thread_store::{IndexOutcome, testing};

fn card_file(dir: &std::path::Path, id: &str) -> CardFile {
    let bytes = std::fs::read(dir.join("threads").join(id).join("card.json")).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn card_json_is_replaced_atomically_with_card_and_fold() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("c", "/w"))
        .unwrap();
    store.append(&t, full_run("r1", "i1", "x")).unwrap();
    let file = card_file(dir.path(), "t");
    assert_eq!(file.v, 1);
    let (card, fold) = replay(dir.path(), "t");
    assert!(same_card(&file.card, &card));
    assert_eq!(file.fold, fold);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("threads/t"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn missing_corrupt_or_newer_card_json_is_refolded_on_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (store, _) = open(dir.path());
        for id in ["a", "b", "c"] {
            store
                .create_thread(Some(tid(id)), created(id, "/w"))
                .unwrap();
            store.append(&tid(id), full_run("r1", "i1", id)).unwrap();
        }
    }
    std::fs::remove_file(dir.path().join("threads/a/card.json")).unwrap();
    std::fs::write(dir.path().join("threads/b/card.json"), b"{not json").unwrap();
    let mut newer = card_file(dir.path(), "c");
    newer.v = 2;
    std::fs::write(
        dir.path().join("threads/c/card.json"),
        serde_json::to_vec(&newer).unwrap(),
    )
    .unwrap();
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, report) = open(dir.path());
    assert!(matches!(report.index, IndexOutcome::Rebuilt { .. }));
    let mut refolded = report.refolded.clone();
    refolded.sort();
    assert_eq!(refolded, vec!["a", "b", "c"]);
    for id in ["a", "b", "c"] {
        let (card, _) = replay(dir.path(), id);
        assert!(same_card(&store.card(&tid(id)).unwrap().unwrap(), &card));
    }
}

#[test]
fn a_log_tail_ahead_of_the_cached_card_is_folded_on_first_touch() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("old title", "/w"))
            .unwrap();
    }
    append_raw(
        dir.path(),
        "t",
        br#"{"v":1,"seq":2,"at":"2026-11-28T10:00:00Z","type":"thread.changed","title":"new title"}
"#,
    );
    let (store, report) = open(dir.path());
    assert_eq!(
        report.logs_opened, 0,
        "clean row: no log is read at startup"
    );
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!((card.title.as_str(), card.applied_seq), ("new title", 2));
    assert_eq!(card_file(dir.path(), "t").card.title, "new title");
}

#[cfg(unix)]
#[test]
fn a_failed_card_write_keeps_the_append_and_the_dirty_mark() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    let thread_dir = dir.path().join("threads/t");
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("before", "/w"))
            .unwrap();
        std::fs::set_permissions(&thread_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        // goat.jsonl is already open for appending; card.json cannot be replaced.
        let out = store.append(&t, vec![renamed("after")]);
        std::fs::set_permissions(&thread_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = out.expect("append succeeds although the cache write failed");
        assert_eq!(out.card.title, "after");
        assert!(store.cache_error(&t).is_some());
        testing::crash(store);
    }
    assert_eq!(card_file(dir.path(), "t").card.title, "before");
    let (store, report) = open(dir.path());
    assert_eq!(report.logs_opened, 1, "the dirty row is checked");
    assert_eq!(store.card(&t).unwrap().unwrap().title, "after");
    assert_eq!(card_file(dir.path(), "t").card.title, "after");
}

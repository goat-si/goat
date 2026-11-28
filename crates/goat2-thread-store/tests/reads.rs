mod common;

use common::*;
use goat2_thread_store::contract::*;
use goat2_thread_store::{Store, StoreError, ThreadRead};

fn renames(store: &Store, t: &ThreadId, n: usize) {
    for chunk in (0..n).collect::<Vec<_>>().chunks(50) {
        let events = chunk
            .iter()
            .map(|i| renamed(&format!("title {i}")))
            .collect();
        store.append(t, events).unwrap();
    }
}

fn fold_suffix(read: &ThreadRead) -> (ThreadCard, Fold) {
    let snap = read.snapshot.as_ref().expect("snapshot");
    let mut card = snap.card.clone();
    let mut fold = snap.fold.clone();
    for line in &read.lines {
        goat2_thread_store::fold::apply(&mut card, &mut fold, line);
    }
    (card, fold)
}

#[test]
fn initial_read_of_a_short_thread_returns_every_line() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("r", "/w"))
        .unwrap();
    renames(&store, &t, 5);
    let read = store.read(&t, None).unwrap();
    assert!(read.reset.is_none() && read.snapshot.is_none());
    assert_eq!(read.lines.first().unwrap().seq, 1);
    assert_eq!(read.lines.last().unwrap().seq, 6);
    assert_eq!(read.cursor.unwrap().seq, 6);
}

#[test]
fn cursor_reads_follow_the_contract() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    let card = store
        .create_thread(Some(t.clone()), created("r", "/w"))
        .unwrap();
    renames(&store, &t, 300);
    let head = 301;
    let at = |seq| ThreadCursor {
        epoch: card.epoch.clone(),
        seq,
    };
    // At the head: nothing.
    let read = store.read(&t, Some(&at(head))).unwrap();
    assert!(read.reset.is_none() && read.lines.is_empty() && read.snapshot.is_none());
    // Exactly 128 behind: lines, no reset.
    let read = store.read(&t, Some(&at(head - 128))).unwrap();
    assert!(read.reset.is_none());
    assert_eq!(read.lines.len(), 128);
    assert_eq!(read.lines[0].seq, head - 127);
    // 129 behind: too far, snapshot instead.
    let read = store.read(&t, Some(&at(head - 129))).unwrap();
    assert_eq!(read.reset, Some(ResetReason::TooFarBehind));
    assert!(read.snapshot.is_some());
    // Past the head.
    let read = store.read(&t, Some(&at(head + 1))).unwrap();
    assert_eq!(read.reset, Some(ResetReason::InvalidCursor));
    // Another epoch.
    let other = ThreadCursor {
        epoch: Epoch::new("other"),
        seq: 3,
    };
    assert_eq!(
        store.read(&t, Some(&other)).unwrap().reset,
        Some(ResetReason::EpochChanged)
    );
    // Missing thread.
    let read = store.read(&tid("nope"), Some(&at(1))).unwrap();
    assert_eq!(read.reset, Some(ResetReason::ThreadMissing));
    assert!(read.cursor.is_none());
}

#[test]
fn a_reader_more_than_one_mebibyte_behind_gets_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    let card = store
        .create_thread(Some(t.clone()), created("r", "/w"))
        .unwrap();
    let text = "y".repeat(60_000);
    for i in 0..20 {
        store
            .append(&t, vec![notified(&format!("{i}{text}"))])
            .unwrap();
    }
    let at = |seq| ThreadCursor {
        epoch: card.epoch.clone(),
        seq,
    };
    let near = store.read(&t, Some(&at(21 - 15))).unwrap();
    assert!(near.reset.is_none(), "15 lines of ~60 KB are under 1 MiB");
    let far = store.read(&t, Some(&at(21 - 19))).unwrap();
    assert_eq!(far.reset, Some(ResetReason::TooFarBehind));
}

#[test]
fn snapshots_come_from_complete_checkpoints_or_the_current_state() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("r", "/w"))
        .unwrap();
    renames(&store, &t, 200);
    store.append(&t, full_run("r1", "i1", "x")).unwrap();
    store
        .append(&t, vec![input("i2", "held"), renamed("after")])
        .unwrap();
    let read = store.read(&t, None).unwrap();
    let snap = read.snapshot.as_ref().unwrap();
    assert!(snap.from_checkpoint);
    let (card, fold) = fold_suffix(&read);
    let (rcard, rfold) = replay(dir.path(), "t");
    assert!(same_card(&card, &rcard));
    assert_eq!(fold, rfold);

    // Without any checkpoint and over the limits: the current state, history via read_page.
    let u = tid("u");
    store
        .create_thread(Some(u.clone()), created("u", "/w"))
        .unwrap();
    renames(&store, &u, 200);
    let read = store.read(&u, None).unwrap();
    let snap = read.snapshot.as_ref().unwrap();
    assert!(!snap.from_checkpoint);
    assert!(read.lines.is_empty());
    assert_eq!(snap.seq, 201);
    assert_eq!(snap.fold, replay(dir.path(), "u").1);
}

#[test]
fn a_checkpoint_missing_fold_keys_is_rejected_by_the_v1_format() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    let epoch;
    {
        let (store, _) = open(dir.path());
        epoch = store
            .create_thread(Some(t.clone()), created("r", "/w"))
            .unwrap()
            .epoch;
        store
            .create_thread(Some(tid("kid")), child_created("kid", "t"))
            .unwrap();
        store
            .append(
                &t,
                vec![
                    input("i1", "x"),
                    started("r1", &["i1"]),
                    child_started("kid"),
                    finished("r1", RunOutcome::Unknown),
                ],
            )
            .unwrap();
        renames(&store, &t, 150);
    }
    // Format v1 requires every Fold key; a checkpoint missing them is not a valid v1 line.
    let (card, _) = replay(dir.path(), "t");
    let seq = card.applied_seq + 1;
    let mut old_card = serde_json::to_value(&card).unwrap();
    old_card["appliedSeq"] = seq.into();
    let line = serde_json::json!({
        "v": 1, "seq": seq, "at": "2026-11-28T10:00:00Z", "type": "checkpoint",
        "card": old_card,
        "fold": { "activeRunId": null, "queuedInputs": [], "openRequests": [], "counters": {"inputs": 0, "runs": 0, "items": 0} }
    });
    let mut bytes = serde_json::to_vec(&line).unwrap();
    bytes.push(b'\n');
    append_raw(dir.path(), "t", &bytes);
    let _ = epoch;
    let (store, _) = open(dir.path());
    assert!(matches!(
        store.read(&t, None),
        Err(StoreError::CorruptLog { .. })
    ));
    assert!(matches!(
        store.append(&t, vec![renamed("x")]),
        Err(StoreError::CorruptLog { .. })
    ));
    assert!(store.read_raw(&t, seq - 1, 5).unwrap()[0].contains("\"checkpoint\""));
}

#[test]
fn pages_walk_back_to_the_first_line() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("p", "/w"))
        .unwrap();
    renames(&store, &t, 299);
    let mut before = 301;
    let mut seen = Vec::new();
    loop {
        let page = store.read_page(&t, before, 100).unwrap();
        let seqs: Vec<u64> = page.lines.iter().map(|l| l.seq).collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
        seen.splice(0..0, seqs.iter().copied());
        before = seqs[0];
        if !page.has_more {
            break;
        }
    }
    assert_eq!(seen, (1..=300).collect::<Vec<_>>());
    assert!(matches!(
        store.read_page(&t, 10, 0),
        Err(StoreError::InvalidLimit(0))
    ));
    assert!(matches!(
        store.read_page(&t, 10, 513),
        Err(StoreError::InvalidLimit(513))
    ));
    assert!(matches!(
        store.read_page(&t, 302, 10),
        Err(StoreError::InvalidCursor(_))
    ));
}

#[test]
fn a_page_stops_at_one_mebibyte() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("p", "/w"))
        .unwrap();
    let text = "z".repeat(60_000);
    for _ in 0..30 {
        store.append(&t, vec![notified(&text)]).unwrap();
    }
    let page = store.read_page(&t, 32, 100).unwrap();
    assert!(
        page.lines.len() < 30 && page.lines.len() >= 15,
        "{}",
        page.lines.len()
    );
    assert!(page.has_more);
}

#[test]
fn subscriptions_replay_then_go_live_without_a_gap() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    renames(&store, &t, 3);
    let (read, rx) = store.subscribe_thread(&t, None).unwrap();
    assert_eq!(read.lines.last().unwrap().seq, 4);
    store.append(&t, vec![renamed("live")]).unwrap();
    let update = rx.try_recv().unwrap();
    assert_eq!(update.lines[0].seq, 5);
}

#[test]
fn an_overflowing_subscriber_is_dropped_and_resumes_from_its_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    let card = store
        .create_thread(Some(t.clone()), created("s", "/w"))
        .unwrap();
    let (_, rx) = store.subscribe_thread(&t, None).unwrap();
    for i in 0..1100 {
        store.append(&t, vec![renamed(&format!("{i}"))]).unwrap();
    }
    let got: Vec<u64> = rx
        .iter()
        .flat_map(|u| u.lines.into_iter().map(|l| l.seq))
        .collect();
    assert_eq!(got.len(), 1024, "channel closes after it fills");
    let last = *got.last().unwrap();
    let cursor = ThreadCursor {
        epoch: card.epoch.clone(),
        seq: last,
    };
    let (resumed, _rx) = store.subscribe_thread(&t, Some(&cursor)).unwrap();
    assert!(resumed.reset.is_none());
    assert_eq!(resumed.lines.first().unwrap().seq, last + 1);
    assert_eq!(resumed.lines.last().unwrap().seq, 1101);
}

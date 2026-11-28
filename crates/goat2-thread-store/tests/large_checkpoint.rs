//! A checkpoint after run.finished copies the fold, so open requests with embedded items (step 3d,
//! runless requests) and the card's contextUsage (step 3a) can make it far larger than one event.
//! It is not limited to 64 KiB like caller events; tail checks, refolds and snapshots must cope.

mod common;

use common::*;
use goat2_thread_store::contract::*;

const REQUESTS: usize = 20;

fn runless_request_with_item(n: usize) -> LogEvent {
    let LogEvent::ItemCompleted(done) =
        answer("none", &format!("ask-item-{n}"), &"q".repeat(60_000))
    else {
        unreachable!()
    };
    let mut item = done.item;
    item.run_id = None;
    LogEvent::RequestOpened(RequestOpened {
        request_id: RequestId::new(format!("ask-{n}")),
        run_id: None,
        item_id: Some(item.id.clone()),
        kind: RequestKind::Question,
        summary: format!("question {n}"),
        options: None,
        recommended: None,
        context: None,
        item: Some(Box::new(item)),
    })
}

fn usage() -> Box<ThreadTokenUsageSnapshot> {
    Box::new(serde_json::from_value(serde_json::json!({"usedTokens": 4242})).unwrap())
}

/// Thread t: REQUESTS runless questions with ~60 KB items, then a run that finishes with token
/// usage, so the checkpoint line alone is over 1 MiB. Returns that line's length.
fn write_big_checkpoint(dir: &std::path::Path) -> usize {
    let (store, _) = open(dir);
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("big", "/w"))
        .unwrap();
    for n in 0..REQUESTS {
        store
            .append(&t, vec![runless_request_with_item(n)])
            .unwrap();
    }
    let mut run = full_run("r1", "i1", "go");
    if let Some(LogEvent::RunFinished(end)) = run.last_mut() {
        end.token_usage = Some(usage());
    }
    store.append(&t, run).unwrap();
    let text = log_text(dir, "t");
    let checkpoint = text
        .lines()
        .find(|l| l.contains("\"type\":\"checkpoint\""))
        .expect("checkpoint line");
    checkpoint.len()
}

/// Drop both caches so the next start must verify the tail and refold the thread from its log.
fn lose_caches(dir: &std::path::Path) {
    std::fs::remove_file(dir.join("cards.sqlite")).unwrap();
    std::fs::remove_file(dir.join("threads/t/card.json")).unwrap();
}

#[test]
fn a_checkpoint_over_one_mebibyte_as_the_last_line_is_refolded_and_served_as_a_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let len = write_big_checkpoint(dir.path());
    assert!(len > 1024 * 1024, "{len}");
    let t = tid("t");
    lose_caches(dir.path());
    let (store, report) = open(dir.path());
    assert_eq!(report.refolded, vec!["t".to_string()]);
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.open_asks, REQUESTS as u32);
    assert_eq!(card.context_usage, Some(usage()));
    // The checkpoint is the head: a reader just before it is too far behind (one line > 1 MiB).
    let head = store.read(&t, None).unwrap().cursor.unwrap();
    let behind = ThreadCursor {
        epoch: head.epoch.clone(),
        seq: head.seq - 1,
    };
    let read = store.read(&t, Some(&behind)).unwrap();
    assert_eq!(read.reset, Some(ResetReason::TooFarBehind));
    let snap = read.snapshot.expect("snapshot");
    assert!(snap.from_checkpoint);
    assert_eq!(snap.seq, head.seq);
    assert_eq!(snap.fold.open_requests.len(), REQUESTS);
    assert!(snap.fold.open_requests.iter().all(|r| r.item.is_some()));
    assert_eq!(snap.card.context_usage, Some(usage()));
    assert!(read.lines.is_empty());
    // History paging: a line over the 1 MiB page budget comes back whole and alone (as in v1),
    // and the next page continues with the lines before it.
    let page = store.read_page(&t, head.seq + 1, 5).unwrap();
    let seqs: Vec<u64> = page.lines.iter().map(|l| l.seq).collect();
    assert_eq!(seqs, vec![head.seq]);
    assert_eq!(page.lines[0].event.type_tag(), "checkpoint");
    assert!(page.has_more);
    let page = store.read_page(&t, head.seq, 2).unwrap();
    let seqs: Vec<u64> = page.lines.iter().map(|l| l.seq).collect();
    assert_eq!(seqs, vec![head.seq - 2, head.seq - 1]);
}

#[test]
fn a_big_checkpoint_before_the_tail_is_refolded_and_serves_snapshots_with_the_suffix() {
    let dir = tempfile::tempdir().unwrap();
    write_big_checkpoint(dir.path());
    let t = tid("t");
    {
        let (store, _) = open(dir.path());
        store
            .append(&t, vec![renamed("after the checkpoint")])
            .unwrap();
    }
    lose_caches(dir.path());
    let (store, report) = open(dir.path());
    assert_eq!(report.refolded, vec!["t".to_string()]);
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.title, "after the checkpoint");
    assert_eq!(card.context_usage, Some(usage()));
    let head = store.read(&t, None).unwrap().cursor.unwrap();
    let behind = ThreadCursor {
        epoch: head.epoch.clone(),
        seq: 1,
    };
    let read = store.read(&t, Some(&behind)).unwrap();
    assert_eq!(read.reset, Some(ResetReason::TooFarBehind));
    let snap = read.snapshot.expect("snapshot");
    assert!(snap.from_checkpoint);
    assert_eq!(snap.fold.open_requests.len(), REQUESTS);
    assert_eq!(read.lines.len(), 1);
    assert_eq!(read.lines[0].event.type_tag(), "thread.changed");
}

/// Timing probe for review 17 (MEDIUM 2): reverse reads across a ~9 MB checkpoint line.
/// cargo test --release -p goat2-thread-store --test large_checkpoint -- --ignored --nocapture
#[test]
#[ignore]
fn reverse_reads_across_a_nine_megabyte_checkpoint_timing() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = goat2_thread_store::Store::open(
        dir.path(),
        goat2_thread_store::StoreOptions {
            fsync: false,
            ..Default::default()
        },
    )
    .unwrap();
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("big", "/w"))
        .unwrap();
    for n in 0..150 {
        store
            .append(&t, vec![runless_request_with_item(n)])
            .unwrap();
    }
    store.append(&t, full_run("r1", "i1", "go")).unwrap();
    store.append(&t, vec![renamed("after")]).unwrap();
    let head = store.read(&t, None).unwrap().cursor.unwrap();
    let mut page_ms = Vec::new();
    let mut read_ms = Vec::new();
    for _ in 0..5 {
        let s = std::time::Instant::now();
        let page = store.read_page(&t, head.seq, 5).unwrap();
        page_ms.push(s.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(page.lines.len(), 1);
        let s = std::time::Instant::now();
        let behind = ThreadCursor {
            epoch: head.epoch.clone(),
            seq: 1,
        };
        let read = store.read(&t, Some(&behind)).unwrap();
        read_ms.push(s.elapsed().as_secs_f64() * 1000.0);
        assert!(read.snapshot.unwrap().from_checkpoint);
    }
    page_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    read_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "TIMING read_page median {:.1} ms, read(seq 1) median {:.1} ms",
        page_ms[2], read_ms[2]
    );
}

//! A checkpoint after run.finished copies the fold, so open requests with embedded items (step 3d,
//! runless requests) and the card's contextUsage (step 3a) can make it far larger than one event.
//! It is not limited to 64 KiB like caller events; tail checks, rebuild and snapshots must cope.

mod common;

use common::*;
use goat2_thread_store::contract::*;

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

#[test]
fn a_checkpoint_far_larger_than_one_event_survives_rebuild_and_serves_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let t = tid("t");
    let usage: Box<ThreadTokenUsageSnapshot> =
        Box::new(serde_json::from_value(serde_json::json!({"usedTokens": 4242})).unwrap());
    {
        let (store, _) = open(dir.path());
        store
            .create_thread(Some(t.clone()), created("big", "/w"))
            .unwrap();
        for n in 0..12 {
            store
                .append(&t, vec![runless_request_with_item(n)])
                .unwrap();
        }
        let mut run = full_run("r1", "i1", "go");
        if let Some(LogEvent::RunFinished(end)) = run.last_mut() {
            end.token_usage = Some(usage.clone());
        }
        store.append(&t, run).unwrap();
        store
            .append(&t, vec![renamed("after the checkpoint")])
            .unwrap();
    }
    // The checkpoint line holds all twelve embedded items: well over 64 KiB.
    let text = log_text(dir.path(), "t");
    let checkpoint = text
        .lines()
        .find(|l| l.contains("\"type\":\"checkpoint\""))
        .expect("checkpoint line");
    assert!(checkpoint.len() > 12 * 60_000, "{}", checkpoint.len());
    // Losing the index makes startup verify every tail and refold from the folders.
    std::fs::remove_file(dir.path().join("cards.sqlite")).unwrap();
    let (store, _) = open(dir.path());
    let card = store.card(&t).unwrap().unwrap();
    assert_eq!(card.open_asks, 12);
    assert_eq!(card.context_usage, Some(usage.clone()));
    assert_eq!(card.title, "after the checkpoint");
    // A reader more than 1 MiB behind gets the checkpoint as its snapshot, then the suffix.
    let head = store.read(&t, None).unwrap().cursor.unwrap();
    let behind = ThreadCursor {
        epoch: head.epoch.clone(),
        seq: 1,
    };
    let read = store.read(&t, Some(&behind)).unwrap();
    let snap = read.snapshot.expect("snapshot");
    assert!(snap.from_checkpoint);
    assert_eq!(snap.fold.open_requests.len(), 12);
    assert!(snap.fold.open_requests.iter().all(|r| r.item.is_some()));
    assert_eq!(snap.card.context_usage, Some(usage));
    assert_eq!(read.lines.len(), 1);
    assert_eq!(read.lines[0].event.type_tag(), "thread.changed");
}

mod common;

use common::*;
use goat2_thread_store::contract::*;

const LOG: &str = include_str!("../../goat2-contracts/tests/frozen_v1/goat.jsonl");
const CARD: &str = include_str!("../../goat2-contracts/tests/frozen_v1/card.json");

/// The store reads lane C's frozen format v1 sample (all 15 event types) and folds the same card.
#[test]
fn the_frozen_v1_sample_thread_loads_and_folds_to_its_card_file() {
    let file: CardFile = serde_json::from_str(CARD).unwrap();
    let id = file.card.id.clone();
    for with_card_json in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let thread_dir = dir.path().join("threads").join(id.as_str());
        std::fs::create_dir_all(&thread_dir).unwrap();
        std::fs::write(thread_dir.join("goat.jsonl"), LOG).unwrap();
        if with_card_json {
            std::fs::write(thread_dir.join("card.json"), CARD).unwrap();
        }
        let (store, report) = open(dir.path());
        assert_eq!(report.threads, 1, "{report:?}");
        assert!(report.corrupt.is_empty(), "{:?}", report.corrupt);
        let card = store.card(&id).unwrap().unwrap();
        assert!(
            same_card(&card, &file.card),
            "card.json present: {with_card_json}"
        );
        let read = store.read(&id, None).unwrap();
        let head = read.cursor.unwrap().seq;
        assert_eq!(head, file.card.applied_seq);
    }
    let dir = tempfile::tempdir().unwrap();
    let thread_dir = dir.path().join("threads").join(id.as_str());
    std::fs::create_dir_all(&thread_dir).unwrap();
    std::fs::write(thread_dir.join("goat.jsonl"), LOG).unwrap();
    let (card, fold) = replay(dir.path(), id.as_str());
    assert!(same_card(&card, &file.card));
    assert_eq!(fold, file.fold);
}

#[test]
fn a_refused_delivery_leaves_the_queue_for_good() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = open(dir.path());
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("r", "/w"))
        .unwrap();
    store
        .append(
            &t,
            vec![
                input("a", "a"),
                input("s", "steer"),
                started("r1", &["a"]),
                delivered("s", "r1", DeliveredAs::Steer, DeliveryOutcome::Refused),
            ],
        )
        .unwrap();
    let fold = replay(dir.path(), "t").1;
    assert_eq!(
        fold.queued_inputs
            .iter()
            .map(|q| q.input_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a"]
    );
    assert!(fold.held_inputs.is_empty());
}

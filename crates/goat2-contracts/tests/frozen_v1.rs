//! Frozen format v1 sample (owner rule 2026-11-28). After the first store merge, these files must
//! keep decoding and re-encoding unchanged; a change that breaks this test needs a version bump and
//! a reader for v1. Do not edit the samples to make a change pass.

use goat2_contracts::*;
use serde_json::{Value, json};

const LOG: &str = include_str!("frozen_v1/goat.jsonl");
const CARD: &str = include_str!("frozen_v1/card.json");

#[test]
fn frozen_log_decodes_and_reencodes_unchanged() {
    let mut lines = LOG.lines();
    let header: LogHeader = serde_json::from_str(lines.next().expect("header")).unwrap();
    assert_eq!(header.v, 1);

    let mut tags = std::collections::BTreeSet::new();
    for (index, text) in lines.enumerate() {
        let ParsedLine::Known(line) = parse_log_line(text).unwrap() else {
            panic!("line {} is not a known event", index + 2)
        };
        assert_eq!(line.v, 1);
        assert_eq!(line.seq, index as u64 + 1, "seq is contiguous from 1");
        let original: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            serde_json::to_value(&*line).unwrap(),
            original,
            "line {}",
            index + 2
        );
        tags.insert(line.event.type_tag());
    }
    let missing: Vec<_> = LogEvent::TYPE_TAGS
        .iter()
        .filter(|t| !tags.contains(*t))
        .collect();
    assert!(
        missing.is_empty(),
        "frozen sample lacks event types {missing:?}"
    );
}

#[test]
fn frozen_card_file_decodes_and_matches_the_log() {
    let card: CardFile = serde_json::from_str(CARD).unwrap();
    assert_eq!(card.v, 1);
    let original: Value = serde_json::from_str(CARD).unwrap();
    assert_eq!(serde_json::to_value(&card).unwrap(), original);

    let last = LOG.lines().last().unwrap();
    let ParsedLine::Known(line) = parse_log_line(last).unwrap() else {
        panic!("checkpoint")
    };
    let LogEvent::Checkpoint(checkpoint) = &line.event else {
        panic!("last line is a checkpoint")
    };
    assert_eq!(checkpoint.card, card.card);
    assert_eq!(checkpoint.fold, card.fold);
    assert_eq!(card.card.applied_seq, line.seq);
}

#[test]
fn readers_skip_unknown_event_types_and_ignore_new_fields() {
    let future =
        r#"{"v":1,"seq":19,"at":"2026-11-28T12:00:19Z","type":"thread.pinned","by":"user"}"#;
    assert_eq!(
        parse_log_line(future).unwrap(),
        ParsedLine::Unknown {
            v: 1,
            seq: 19,
            type_tag: "thread.pinned".into()
        }
    );

    let mut with_new_field: Value = serde_json::from_str(LOG.lines().nth(1).unwrap()).unwrap();
    with_new_field["addedLater"] = json!("optional field from a newer writer");
    let ParsedLine::Known(line) = parse_log_line(&with_new_field.to_string()).unwrap() else {
        panic!("known event with an extra field still decodes")
    };
    assert_eq!(line.event.type_tag(), "thread.created");

    let broken = r#"{"v":1,"seq":2,"at":"x","type":"run.finished","outcome":"done"}"#;
    assert!(
        parse_log_line(broken).is_err(),
        "a known type with a bad payload is an error"
    );
}

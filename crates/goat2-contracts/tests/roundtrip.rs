mod common;

use goat2_contracts::*;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::BTreeSet;

fn roundtrip<T: DeserializeOwned + Serialize>(value: Value) -> Result<Value, String> {
    let parsed: T = serde_json::from_value(value).map_err(|e| e.to_string())?;
    serde_json::to_value(parsed).map_err(|e| e.to_string())
}

fn decode(root: &str, value: Value) -> Result<Value, String> {
    match root {
        "log_line" => roundtrip::<LogLine>(value),
        "log_event" => roundtrip::<LogEvent>(value),
        "log_header" => roundtrip::<LogHeader>(value),
        "turn_item" => roundtrip::<TurnItem>(value),
        "turn_item_body" => roundtrip::<TurnItemBody>(value),
        "client_frame" => roundtrip::<ClientFrame>(value),
        "host_frame" => roundtrip::<HostFrame>(value),
        "provider_capabilities" => roundtrip::<ProviderCapabilities>(value),
        "thread_card" => roundtrip::<ThreadCard>(value),
        "card_file" => roundtrip::<CardFile>(value),
        "fold" => roundtrip::<Fold>(value),
        "bot_profile" => roundtrip::<BotProfile>(value),
        "channel_attention_event" => roundtrip::<ChannelAttentionEvent>(value),
        "decision_answer_input" => roundtrip::<DecisionAnswerInput>(value),
        "decision_escalate_input" => roundtrip::<DecisionEscalateInput>(value),
        "decision_item" => roundtrip::<DecisionItem>(value),
        "decision_request_input" => roundtrip::<DecisionRequestInput>(value),
        "provider_probe_result" => roundtrip::<ProviderProbeResult>(value),
        _ => panic!("unknown root {root}"),
    }
}

fn schema(root: &str) -> Value {
    macro_rules! s {
        ($t:ty) => {
            codegen::schema_value::<$t>()
        };
    }
    match root {
        "log_line" => s!(LogLine),
        "log_event" => s!(LogEvent),
        "log_header" => s!(LogHeader),
        "turn_item" => s!(TurnItem),
        "turn_item_body" => s!(TurnItemBody),
        "client_frame" => s!(ClientFrame),
        "host_frame" => s!(HostFrame),
        "provider_capabilities" => s!(ProviderCapabilities),
        "thread_card" => s!(ThreadCard),
        "card_file" => s!(CardFile),
        "fold" => s!(Fold),
        "bot_profile" => s!(BotProfile),
        "channel_attention_event" => s!(ChannelAttentionEvent),
        "decision_answer_input" => s!(DecisionAnswerInput),
        "decision_escalate_input" => s!(DecisionEscalateInput),
        "decision_item" => s!(DecisionItem),
        "decision_request_input" => s!(DecisionRequestInput),
        "provider_probe_result" => s!(ProviderProbeResult),
        _ => panic!("unknown root {root}"),
    }
}
fn validator(root: &str) -> jsonschema::Validator {
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&schema(root))
        .expect("compile schema")
}

#[test]
fn canonical_and_derived_round_trip_and_validate() {
    let fixtures = common::fixtures();
    let roots: BTreeSet<_> = fixtures.iter().map(|f| f.root.as_str()).collect();
    assert_eq!(roots.len(), codegen::ROOTS.len());
    for fixture in fixtures {
        let label = format!("{}/{}", fixture.root, fixture.name);
        let result =
            decode(&fixture.root, fixture.value.clone()).unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(result, fixture.value, "{label}");
        assert!(
            validator(&fixture.root).is_valid(&fixture.value),
            "{label}: {:?}",
            validator(&fixture.root)
                .iter_errors(&fixture.value)
                .collect::<Vec<_>>()
        );
    }
}

fn schema_tags(root: &str) -> BTreeSet<String> {
    schema(root)["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            v["properties"]["type"]["const"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}
#[test]
fn inventory_covers_all_tags() {
    let fixtures = common::fixtures();
    for root in ["log_event", "turn_item_body", "client_frame", "host_frame"] {
        let actual: BTreeSet<_> = fixtures
            .iter()
            .filter(|f| f.root == root)
            .map(|f| f.value["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(actual, schema_tags(root), "{root}");
        if root == "log_event" {
            assert_eq!(
                actual,
                LogEvent::TYPE_TAGS.iter().map(|s| s.to_string()).collect()
            );
        }
    }
}

#[test]
fn normalize_reader_inputs() {
    for (path, text) in common::files("normalize") {
        let value: Value = serde_json::from_str(&text).unwrap();
        let root = value["root"].as_str().unwrap();
        assert!(validator(root).is_valid(&value["input"]), "{path}");
        assert_eq!(
            decode(root, value["input"].clone()).unwrap(),
            value["output"],
            "{path}"
        );
    }
}

#[test]
fn invalid_inputs_are_rejected() {
    for (path, text) in common::files("invalid") {
        let root = path.split('/').nth(1).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert!(!validator(root).is_valid(&value), "schema accepted {path}");
        assert!(decode(root, value).is_err(), "serde accepted {path}");
    }
}

#[test]
fn max_safe_integer_survives_wire_round_trip() {
    let mut value = common::fixtures()
        .into_iter()
        .find(|f| f.root == "log_line" && f.name == "run_started")
        .unwrap()
        .value;
    value["seq"] = limits::MAX_SAFE_WIRE_INTEGER.into();
    let line: LogLine = serde_json::from_value(value.clone()).unwrap();
    let serialized = serde_json::to_value(&line).unwrap();
    assert_eq!(serialized["seq"], serde_json::json!(9007199254740991_u64));
    assert!(validator("log_line").is_valid(&serialized));
    assert_eq!(serde_json::from_value::<LogLine>(serialized).unwrap(), line);
}

/// v1 limits a decision reason to 2000 UTF-16 code units (JavaScript `length`). Serde enforces
/// exactly that; JSON Schema `maxLength` counts code points, so the schema bound is the same for
/// BMP text and looser outside it.
#[test]
fn decision_reason_counts_utf16_units_like_v1() {
    let answer =
        |reason: String| serde_json::json!({"id": "decision:1", "optionId": "a", "reason": reason});
    let escalate = |reason: String| serde_json::json!({"id": "decision:1", "reason": reason});
    let emoji = |n: usize| "\u{1F600}".repeat(n);
    let bmp = |n: usize| "é".repeat(n);
    for (make, root) in [
        (&answer as &dyn Fn(String) -> Value, "decision_answer_input"),
        (&escalate, "decision_escalate_input"),
    ] {
        // At the limit: both accept.
        for reason in [emoji(1000), bmp(DECISION_REASON_MAX_UTF16)] {
            let value = make(reason);
            assert!(decode(root, value.clone()).is_ok(), "{root}");
            assert!(validator(root).is_valid(&value), "{root}");
        }
        // One BMP character over: both reject.
        let value = make(bmp(DECISION_REASON_MAX_UTF16 + 1));
        assert!(decode(root, value.clone()).is_err(), "{root}");
        assert!(!validator(root).is_valid(&value), "{root}");
        // 1001 emoji = 1001 code points but 2002 UTF-16 units: v1 and serde reject; the
        // code-point schema bound cannot see it.
        let value = make(emoji(1001));
        assert!(decode(root, value.clone()).is_err(), "{root}");
        assert!(validator(root).is_valid(&value), "{root}");
        // v1 trims before counting: padding around a reason at the limit is accepted and
        // removed (the untrimming schema sees 2002 characters).
        let padded = format!(" {}\u{3000}", bmp(DECISION_REASON_MAX_UTF16));
        let decoded = decode(root, make(padded)).unwrap();
        assert_eq!(
            decoded["reason"],
            Value::from(bmp(DECISION_REASON_MAX_UTF16)),
            "{root}"
        );
        assert!(
            decode(
                root,
                make(format!(" {} ", bmp(DECISION_REASON_MAX_UTF16 + 1)))
            )
            .is_err()
        );
    }
}

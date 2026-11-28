//! The driver's capability flags equal GOAT v1 `CodexCapabilities.ts` (checked-in transcription).

use goat2_contracts::ProviderCapabilities;
use goat2_engine_codex::capabilities::{IMPLEMENTED_OPERATIONS, Operation, codex_capabilities};
use serde_json::Value;

#[test]
fn capabilities_equal_v1() {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/v1-codex-capabilities.json"
    ))
    .unwrap();
    let fixture: Value = serde_json::from_str(&text).unwrap();
    // Decode the v1 object with v1's decoding defaults (contracts ProviderCapabilities).
    let v1: ProviderCapabilities = serde_json::from_value(fixture["capabilities"].clone()).unwrap();
    let ours = codex_capabilities();
    assert_eq!(ours, v1);
    // Every v1 flag is present with the same value after serialization.
    let ours_json = serde_json::to_value(&ours).unwrap();
    for (group, flags) in fixture["capabilities"].as_object().unwrap() {
        for (flag, value) in flags.as_object().unwrap() {
            assert_eq!(&ours_json[group][flag], value, "{group}.{flag}");
        }
    }
}

#[test]
fn part1_operations_are_listed() {
    for op in [
        Operation::ThreadStart,
        Operation::ThreadResume,
        Operation::TurnStart,
        Operation::TurnSteer,
        Operation::TurnInterrupt,
        Operation::AnswerRequest,
        Operation::Shutdown,
    ] {
        assert!(IMPLEMENTED_OPERATIONS.contains(&op));
    }
}

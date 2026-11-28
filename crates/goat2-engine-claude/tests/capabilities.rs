//! Capability flags equal GOAT v1 `ClaudeProviderCapabilitiesV2` (`ClaudeAdapterV2.ts:436-531`),
//! evaluated from the v1 source into `fixtures/v1-claude-capabilities.json`.

use goat2_contracts::ProviderCapabilities;
use goat2_engine_api::EngineFactory;
use goat2_engine_claude::{ClaudeEngineFactory, claude_capabilities};
use serde_json::Value;

fn v1() -> Value {
    serde_json::from_str(include_str!("fixtures/v1-claude-capabilities.json")).unwrap()
}

#[test]
fn equal_to_v1_after_v1_decoding() {
    let decoded: ProviderCapabilities = serde_json::from_value(v1()).unwrap();
    assert_eq!(claude_capabilities(), decoded);
    assert_eq!(ClaudeEngineFactory::default().capabilities(), decoded);
}

#[test]
fn every_v1_field_has_the_v1_value() {
    let ours = serde_json::to_value(claude_capabilities()).unwrap();
    fn check(path: &str, v1: &Value, ours: &Value) {
        match v1 {
            Value::Object(map) => {
                for (key, value) in map {
                    check(&format!("{path}.{key}"), value, &ours[key]);
                }
            }
            _ => assert_eq!(v1, ours, "{path}"),
        }
    }
    check("", &v1(), &ours);
}

//! v1 capability flags per driver kind, kept as the v1 objects themselves.
//!
//! Each JSON file is the literal object from goat origin/dev `916b5ccc1b2`, extracted with `eval`
//! of the TypeScript literal (no edits):
//! - `cursor.json`: `packages/provider-cursor/src/server/capabilities.ts:3-101`
//! - `opencode.json`: `packages/provider-opencode/src/server/adapterProtocol.ts:27-122`
//! - `muse.json`: `packages/provider-muse/src/server/capabilities.ts:3-97`
//! - `pi.json`: `packages/provider-pi/src/server/piToolOutput.ts:7-103` (v1 Pi adapter returns it for
//!   both the Pi and OmO profiles, `provider-pi/src/server/adapter.ts:138-139`)

use goat2_contracts::{EngineDriver, ProviderCapabilities};

const CURSOR: &str = include_str!("capabilities/cursor.json");
const OPENCODE: &str = include_str!("capabilities/opencode.json");
const MUSE: &str = include_str!("capabilities/muse.json");
const PI: &str = include_str!("capabilities/pi.json");

fn parse(json: &str) -> ProviderCapabilities {
    serde_json::from_str(json).expect("v1 capability literal matches ProviderCapabilities")
}

/// The v1 flags for a driver this crate serves; `None` for any other driver.
pub fn for_driver(driver: &EngineDriver) -> Option<ProviderCapabilities> {
    let json = match driver {
        EngineDriver::Cursor => CURSOR,
        EngineDriver::Opencode => OPENCODE,
        EngineDriver::Muse => MUSE,
        EngineDriver::Pi | EngineDriver::Omo => PI,
        _ => return None,
    };
    Some(parse(json))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// `subset` holds in `full`: every field of the v1 literal is present with the same value.
    fn contained(subset: &Value, full: &Value) -> bool {
        match (subset, full) {
            (Value::Object(small), Value::Object(big)) => small
                .iter()
                .all(|(key, value)| big.get(key).is_some_and(|other| contained(value, other))),
            _ => subset == full,
        }
    }

    /// Every v1 field survives the trip through the Rust type: nothing dropped, nothing renamed.
    /// The type adds only v1's own decoding defaults (`sessions.executionLocation` etc.).
    #[test]
    fn v1_literals_round_trip_unchanged() {
        for json in [CURSOR, OPENCODE, MUSE, PI] {
            let original: Value = serde_json::from_str(json).unwrap();
            let typed = parse(json);
            let back = serde_json::to_value(&typed).unwrap();
            assert!(contained(&original, &back), "{original} not in {back}");
            assert_eq!(parse(&back.to_string()), typed);
        }
    }

    #[test]
    fn steering_flags_match_v1() {
        let cursor = for_driver(&EngineDriver::Cursor).unwrap();
        assert!(cursor.turns.supports_active_steering);
        assert!(cursor.turns.supports_steering_by_interrupt_restart);
        let muse = for_driver(&EngineDriver::Muse).unwrap();
        assert!(muse.turns.supports_active_steering);
        assert!(!muse.turns.supports_steering_by_interrupt_restart);
        assert_eq!(
            for_driver(&EngineDriver::Pi),
            for_driver(&EngineDriver::Omo)
        );
        assert!(for_driver(&EngineDriver::Codex).is_none());
    }
}

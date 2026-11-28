//! Helpers for provider probes. The factory probe flow is not implemented here yet.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Hash the environment and spawn descriptor for a probe cache key.
///
/// Adapted from v1 `packages/provider-acp-registry/src/server/probeFingerprint.ts:9-20`:
/// sort the environment by name, encode it with the spawn descriptor, then SHA-256.
/// The fingerprint must be treated as sensitive: it depends on environment values.
pub fn probe_fingerprint(environment: &BTreeMap<String, String>, spawn: &Value) -> String {
    #[derive(Serialize)]
    struct Input<'a> {
        environment: Vec<(&'a String, &'a String)>,
        spawn: &'a Value,
    }
    let bytes = serde_json::to_vec(&Input {
        environment: environment.iter().collect(),
        spawn,
    })
    .expect("strings and JSON values are serializable");
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fingerprint_tracks_environment_and_spawn_without_returning_them() {
        let mut env = BTreeMap::from([("PATH".into(), "/fake/bin".into())]);
        let spawn = json!({"command":"fake", "args":["acp"]});
        let first = probe_fingerprint(&env, &spawn);
        assert_eq!(first.len(), 64);
        assert_eq!(first, probe_fingerprint(&env, &spawn));
        env.insert("PATH".into(), "/other/bin".into());
        assert_ne!(first, probe_fingerprint(&env, &spawn));
        env.insert("PATH".into(), "/fake/bin".into());
        assert_ne!(first, probe_fingerprint(&env, &json!({"command":"other"})));
    }
}

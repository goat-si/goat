//! Provider probes: open a session without signing in, read what the agent advertises, delete it.
//! v1 packages/provider-acp-registry/src/server/probe.ts and probeFingerprint.ts.

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

/// v1 probe.ts:72-77.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
pub const COMMAND_ADVERTISEMENT_GRACE: std::time::Duration = std::time::Duration::from_millis(500);
pub const MODEL_ADVERTISEMENT_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
pub const PROBE_SESSION_DELETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A probe that could not open a session.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpProbeFailure {
    pub message: String,
    /// The agent answered session setup with "authentication required".
    pub auth_required: bool,
    /// What `initialize` advertised, for the sign-in actions (v1 normalizeAcpRegistryAuthMethods).
    pub auth_methods: Vec<crate::wire::AuthMethodInfo>,
    /// A sign-in URL the agent printed or sent before failing.
    pub auth_url: Option<String>,
}

/// An open probe session; [AcpProbeSession::close] deletes it when the agent supports that.
pub struct AcpProbeSession {
    pub session: crate::engine::AcpSession,
    pub events: tokio::sync::mpsc::UnboundedReceiver<goat2_engine_api::EngineEvent>,
}

impl AcpProbeSession {
    /// v1 probe.ts:493-498: delete the probe's session (agents that persist sessions would keep one
    /// per probe), then stop the agent.
    pub async fn close(self) {
        use goat2_engine_api::EngineSession;
        let _ = self
            .session
            .delete_session(PROBE_SESSION_DELETE_TIMEOUT)
            .await;
        self.session.shutdown().await;
    }
}

impl crate::engine::AcpEngineFactory {
    /// Open a session the way v1's provider probe does (probe.ts:410-546): never sign in, wait for
    /// the advertised models and commands, and fail within [PROBE_TIMEOUT]. Use a factory built with
    /// [crate::engine::AcpEngineFactory::for_probe].
    pub async fn open_probe(
        &self,
        spec: goat2_engine_api::SessionSpec,
    ) -> Result<AcpProbeSession, AcpProbeFailure> {
        let started = match tokio::time::timeout(PROBE_TIMEOUT, self.start_inner(spec)).await {
            Err(_) => {
                return Err(AcpProbeFailure {
                    message: format!(
                        "The ACP agent did not create a test session within {} seconds. Agent startup may be slow; this check retries on the next provider refresh.",
                        PROBE_TIMEOUT.as_secs()
                    ),
                    auth_required: false,
                    auth_methods: Vec::new(),
                    auth_url: None,
                });
            }
            Ok(Ok(started)) => started,
            Ok(Err(failure)) => {
                let mut auth_url = None;
                if let Some(mut events) = failure.events {
                    while let Ok(event) = events.try_recv() {
                        if let goat2_engine_api::EngineEvent::AuthRequired {
                            url: Some(url), ..
                        } = event
                        {
                            auth_url = Some(url);
                        }
                    }
                }
                let message = failure.error.to_string();
                return Err(AcpProbeFailure {
                    auth_required: message.contains(crate::engine::AUTH_REQUIRED_PREFIX),
                    message,
                    auth_methods: failure.init.map(|i| i.auth_methods).unwrap_or_default(),
                    auth_url,
                });
            }
        };
        started
            .session
            .wait_for_advertisements(MODEL_ADVERTISEMENT_GRACE, COMMAND_ADVERTISEMENT_GRACE)
            .await;
        Ok(AcpProbeSession {
            session: started.session,
            events: started.events,
        })
    }
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

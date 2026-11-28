//! Grok sign-in for a session: the xAI API key and the ACP auth method.
//!
//! Ported from v1 `packages/provider-grok/src/server/auth.ts:19-64` (`GROK_API_KEY_ENV`,
//! `applyStoredGrokApiKey`: the stored key fills `XAI_API_KEY` only when the launch environment has
//! none, so instance and process variables win) and `acpSupport.ts:30-33,164-168`
//! (`resolveGrokAuthMethodId`). v1's in-app key sign-in flow (`makeGrokAuth`) belongs to the
//! provider settings host, not the driver; the driver only reads the key at each launch (v1
//! `readStoredApiKey`, adapter.ts:134-135,400-416). The key is never logged.

use std::sync::Arc;

use goat2_engine_api::SessionSpec;

/// v1 `GROK_API_KEY_ENV`.
pub const GROK_API_KEY_ENV: &str = "XAI_API_KEY";
/// v1 `GROK_AUTH_METHOD_API_KEY`.
pub const GROK_AUTH_METHOD_API_KEY: &str = "xai.api_key";
/// v1 `GROK_AUTH_METHOD_CACHED_TOKEN`.
pub const GROK_AUTH_METHOD_CACHED_TOKEN: &str = "cached_token";

/// Reads the stored xAI key at each launch, so a key saved after the factory was built reaches
/// the CLI (v1 `readStoredGrokApiKey`; blank values read as none).
pub type StoredApiKey = Arc<dyn Fn() -> Option<String> + Send + Sync>;

fn non_blank(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Whether the session's launch environment already carries `XAI_API_KEY`: the host's own
/// environment or the session's launch variables.
pub fn launch_environment_has_key(spec: &SessionSpec) -> bool {
    let from_spec = spec
        .launch
        .as_ref()
        .and_then(|l| l.env.get(GROK_API_KEY_ENV).cloned());
    non_blank(from_spec).is_some() || non_blank(std::env::var(GROK_API_KEY_ENV).ok()).is_some()
}

/// v1 `applyStoredGrokApiKey`: the variable to add for this launch, if any.
pub fn stored_key_variable(spec: &SessionSpec, stored: Option<&StoredApiKey>) -> Option<String> {
    if launch_environment_has_key(spec) {
        return None;
    }
    non_blank(stored.and_then(|read| read()))
}

/// v1 `resolveGrokAuthMethodId`: the API key method when the launch environment has a key,
/// otherwise Grok's cached sign-in token.
pub fn auth_method_id(has_key: bool) -> &'static str {
    if has_key {
        GROK_AUTH_METHOD_API_KEY
    } else {
        GROK_AUTH_METHOD_CACHED_TOKEN
    }
}

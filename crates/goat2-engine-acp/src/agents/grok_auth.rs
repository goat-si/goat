//! Grok sign-in for a session: the xAI API key and the ACP auth method.
//!
//! Ported from v1 `packages/provider-grok/src/server/auth.ts:19-64` (`GROK_API_KEY_ENV`,
//! `applyStoredGrokApiKey`: the stored key fills `XAI_API_KEY` only when the launch environment has
//! none, so instance and process variables win) and `acpSupport.ts:30-33,164-168`
//! (`resolveGrokAuthMethodId`). v1's in-app key sign-in flow (`makeGrokAuth`) belongs to the
//! provider settings host, not the driver; the driver only reads the key at each launch (v1
//! `readStoredApiKey`, adapter.ts:134-135,400-416). The key is never logged.
//!
//! "The launch environment" is the merged one, as in v1 (adapter.ts:400-416 applies the key to
//! the session environment, the instance variables over the process environment): an instance
//! override that sets `XAI_API_KEY` blank masks an inherited key and is itself filled from the
//! stored key, and the sign-in method follows that result (final review 6 finding B2).

use std::sync::Arc;

use goat2_engine_api::SessionSpec;

use crate::flavor::LaunchCommand;

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

/// v1 `applyStoredGrokApiKey` on a merged environment: `set` is `XAI_API_KEY` as the launch
/// variables set it (None when they leave it alone) and `inherited` the host's. Returns whether
/// the merged environment ends up with a key, and the stored key to set when it has to fill a
/// blank or missing one.
pub fn resolve_key(
    set: Option<&str>,
    inherited: Option<String>,
    stored: Option<&StoredApiKey>,
) -> (bool, Option<String>) {
    let effective = match set {
        Some(value) => Some(value.to_owned()),
        None => inherited,
    };
    if non_blank(effective).is_some() {
        return (true, None);
    }
    let fill = non_blank(stored.and_then(|read| read()));
    (fill.is_some(), fill)
}

fn inherited_key() -> Option<String> {
    std::env::var(GROK_API_KEY_ENV).ok()
}

/// [resolve_key] for a session: the session's launch variables over the host environment.
pub fn resolve_for_spec(
    spec: &SessionSpec,
    stored: Option<&StoredApiKey>,
) -> (bool, Option<String>) {
    let set = spec
        .launch
        .as_ref()
        .and_then(|l| l.env.get(GROK_API_KEY_ENV))
        .map(String::as_str);
    resolve_key(set, inherited_key(), stored)
}

/// Whether the session's merged launch environment carries a non-blank `XAI_API_KEY`: the
/// session's launch variable when it sets one (even blank), otherwise the host's.
pub fn launch_environment_has_key(spec: &SessionSpec) -> bool {
    resolve_for_spec(spec, None).0
}

/// v1 `applyStoredGrokApiKey`: the variable to add for this launch, if any.
pub fn stored_key_variable(spec: &SessionSpec, stored: Option<&StoredApiKey>) -> Option<String> {
    resolve_for_spec(spec, stored).1
}

/// v1 `applyStoredGrokApiKey` on the final command, after the session's launch overrides were
/// merged in: a blank or missing `XAI_API_KEY` (the last one the command sets, else the inherited
/// one unless the command removes it) is filled from the stored key.
pub fn apply_to_merged(command: &mut LaunchCommand, stored: Option<&StoredApiKey>) {
    let set = command
        .env
        .iter()
        .rev()
        .find(|(name, _)| name == GROK_API_KEY_ENV)
        .map(|(_, value)| value.as_str());
    let removed = command.env_remove.iter().any(|name| {
        name == GROK_API_KEY_ENV
            || name
                .strip_suffix('*')
                .is_some_and(|prefix| GROK_API_KEY_ENV.starts_with(prefix))
    });
    let inherited = if removed { None } else { inherited_key() };
    if let (_, Some(key)) = resolve_key(set, inherited, stored) {
        command.env.retain(|(name, _)| name != GROK_API_KEY_ENV);
        command.env.push((GROK_API_KEY_ENV.to_owned(), key));
    }
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

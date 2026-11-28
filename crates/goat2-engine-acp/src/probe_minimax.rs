//! MiniMax Code account quota, lifted from GOAT v1 (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-acp-registry/src/server/minimaxCodeAccountQuota.ts` (private profile reads,
//!   sign-in checks, the two private MiniMax routes, quota windows, keep-last-reading rules)
//! - `packages/provider-acp-registry/src/server/minimaxCodeUsageEnrichment.ts` (when the quota is read)
//!
//! GOAT 2's `ProviderProbeResult` has no usage-limits field yet, so the reading is returned beside the
//! probe result ([super::registry::RegistryStatus::usage]).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::registry::index::RegistrySettings;

/// v1 minimaxCodeAccountQuota.ts:13-19.
const MAX_BYTES: usize = 64 * 1024;
const CLIENT: &str = "mcode-public";
const AUDIENCE: &str = "agent-backend";
const READ_TIMEOUT: Duration = Duration::from_secs(4);

fn origins(region: &str) -> (&'static str, &'static str) {
    if region == "cn" {
        ("https://agent.minimaxi.com", "https://www.minimaxi.com")
    } else {
        ("https://agent.minimax.io", "https://platform.minimax.io")
    }
}

type Json = Map<String, Value>;

fn record(value: Option<&Value>) -> Option<&Json> {
    value.and_then(Value::as_object)
}

fn region(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str) {
        Some("cn") => Some("cn"),
        Some("en") => Some("en"),
        _ => None,
    }
}

/// v1 `ServerProviderUsageWindow`.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageWindow {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub used_percent: f64,
    pub window_duration_mins: u32,
    pub resets_at: Option<String>,
}

/// v1 `ServerProviderUsageLimits`.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageLimits {
    pub checked_at: String,
    pub windows: Vec<UsageWindow>,
}

/// v1's three answers: a reading, `null` (the signed-in account is gone or unconfirmed) or
/// `undefined` (a read failed for the account the last reading came from, which keeps it).
#[derive(Debug, Clone, PartialEq)]
pub enum QuotaReading {
    Reading(UsageLimits),
    SignedOut,
    KeepLast,
}

/// One HTTP request to MiniMax (redirects are refused, as v1 `redirect: "error"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// A response whose body was read up to [MAX_BYTES]; `body` is None when it was larger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaResponse {
    pub ok: bool,
    pub content_length: Option<u64>,
    pub body: Option<Vec<u8>>,
}

/// The HTTP seam (tests answer in-process).
#[async_trait]
pub trait QuotaHttp: Send + Sync {
    async fn send(&self, request: QuotaRequest) -> Option<QuotaResponse>;
}

/// [QuotaHttp] over reqwest.
pub struct ReqwestQuotaHttp(reqwest::Client);

impl ReqwestQuotaHttp {
    pub fn new() -> Option<Self> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()
            .map(Self)
    }
}

#[async_trait]
impl QuotaHttp for ReqwestQuotaHttp {
    async fn send(&self, request: QuotaRequest) -> Option<QuotaResponse> {
        use futures::StreamExt;
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).ok()?;
        let mut builder = self.0.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder.send().await.ok()?;
        let ok = response.status().is_success();
        let content_length = response.content_length();
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.ok()?;
            if body.len() + chunk.len() > MAX_BYTES {
                return Some(QuotaResponse {
                    ok,
                    content_length,
                    body: None,
                });
            }
            body.extend_from_slice(&chunk);
        }
        Some(QuotaResponse {
            ok,
            content_length,
            body: Some(body),
        })
    }
}

/// v1 `boundedJson` (minimaxCodeAccountQuota.ts:127-144).
fn bounded_json(response: Option<QuotaResponse>) -> Option<Json> {
    let response = response?;
    if !response.ok
        || response
            .content_length
            .is_some_and(|l| l > MAX_BYTES as u64)
    {
        return None;
    }
    match serde_json::from_slice::<Value>(&response.body?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Lexical `path.resolve` for an absolute path.
fn resolve_absolute(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// v1 `profileRoot` (minimaxCodeAccountQuota.ts:65-73): only `mcode acp` with an explicit absolute
/// `MINIMAX_DATA_DIR` on the production build.
pub fn profile_root(env: &BTreeMap<String, String>, args: &[String]) -> Option<PathBuf> {
    if args.len() != 1 || args[0] != "acp" {
        return None;
    }
    if let Some(build) = env.get("MAVIS_BUILD_ENV")
        && !build.is_empty()
        && build != "prod"
    {
        return None;
    }
    let root = env.get("MINIMAX_DATA_DIR")?.trim();
    if root.is_empty() || !Path::new(root).is_absolute() {
        return None;
    }
    Some(resolve_absolute(Path::new(root)))
}

/// v1 `readPrivateJson` (minimaxCodeAccountQuota.ts:29-63): refuse redirected paths, devices,
/// symlinks, foreign owners and files others can read.
#[cfg(unix)]
fn read_private_json(path: &Path, uid: u32) -> Option<Json> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if std::fs::canonicalize(path).ok()? != path {
        return None;
    }
    let parent = std::fs::metadata(path.parent()?).ok()?;
    if !parent.is_dir() || parent.uid() != uid || parent.mode() & 0o077 != 0 {
        return None;
    }
    let before = std::fs::symlink_metadata(path).ok()?;
    if !before.is_file() {
        return None;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return None;
    }
    if metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
        return None;
    }
    if before.dev() != metadata.dev() || before.ino() != metadata.ino() {
        return None;
    }
    if std::fs::canonicalize(path).ok()? != path {
        return None;
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_BYTES {
        return None;
    }
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

#[cfg(not(unix))]
fn read_private_json(_path: &Path, _uid: u32) -> Option<Json> {
    None
}

/// v1 `chooseRegion`.
fn choose_region(root: &Path, uid: u32, configured: Option<&str>) -> Option<&'static str> {
    if let Some(configured) = configured.filter(|c| !c.is_empty()) {
        return region(Some(&Value::String(configured.to_owned())));
    }
    let preference = read_private_json(&root.join("preferences").join("mcode-region.json"), uid)?;
    if preference.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    region(record(preference.get("regions")).and_then(|r| r.get("prod")))
}

struct Login {
    token: String,
    generation: Value,
}

fn is_safe_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// v1 `readLogin` (minimaxCodeAccountQuota.ts:85-125).
fn read_login(root: &Path, uid: u32, selected: &str, now: i64) -> Option<Login> {
    let directory = root.join("auth").join("prod").join(selected).join(CLIENT);
    let state = read_private_json(&directory.join("auth-state.json"), uid)?;
    let s = |key: &str| state.get(key).and_then(Value::as_str);
    if state.get("schemaVersion").and_then(Value::as_f64) != Some(2.0)
        || s("status") != Some("authenticated")
        || s("storeKind") != Some("file")
        || s("buildEnv") != Some("prod")
        || s("region") != Some(selected)
        || s("clientId") != Some(CLIENT)
        || s("audience") != Some(AUDIENCE)
        || !is_safe_integer(state.get("generation"))
    {
        return None;
    }
    let payload = read_private_json(&directory.join("auth.json"), uid)?;
    if payload.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(root.join("auth").to_string_lossy().as_bytes());
    hasher.update(b"\0");
    hasher.update(CLIENT.as_bytes());
    let account = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    let key = format!("com.minimax.mcode.oauth.prod.{selected}\0{account}");
    let login = record(record(payload.get("records")).and_then(|r| r.get(&key)))?;
    let l = |key: &str| login.get(key).and_then(Value::as_str);
    let token = l("accessToken")?;
    let expires = login.get("expiresAtMs").and_then(Value::as_f64);
    let token_ok = token.len() <= 8192
        && !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._~+/=-".contains(c));
    if login.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
        || l("clientId") != Some(CLIENT)
        || l("audience") != Some(AUDIENCE)
        || l("tokenType") != Some("Bearer")
        || login.get("generation") != state.get("generation")
        || login.get("expiresAtMs") != state.get("expiresAtMs")
        || !expires.is_some_and(|e| e.is_finite() && e > (now + 4_000) as f64)
        || !token_ok
    {
        return None;
    }
    Some(Login {
        token: token.to_owned(),
        generation: login.get("generation").cloned().unwrap_or(Value::Null),
    })
}

/// v1 `personalGroup` (minimaxCodeAccountQuota.ts:146-163).
fn personal_group(payload: Option<&Json>) -> Option<String> {
    let payload = payload?;
    let code = record(payload.get("statusInfo")).and_then(|s| s.get("code"));
    let base_code = record(payload.get("base_resp")).and_then(|s| s.get("status_code"));
    let zero = |v: Option<&Value>| v.and_then(Value::as_f64) == Some(0.0);
    if !zero(code.or(base_code)) || (base_code.is_some() && !zero(base_code)) {
        return None;
    }
    let workspaces = payload
        .get("workspaces")
        .or_else(|| record(payload.get("data")).and_then(|d| d.get("workspaces")))?
        .as_array()?;
    let personal: Vec<Option<&Json>> = workspaces
        .iter()
        .map(|w| w.as_object())
        .filter(|w| {
            w.and_then(|w| w.get("workspace_type"))
                .and_then(Value::as_f64)
                == Some(0.0)
        })
        .collect();
    if personal.len() != 1 {
        return None;
    }
    let workspace = personal[0]?;
    if workspace.get("has_token_plan") == Some(&Value::Bool(false)) {
        return None;
    }
    let id_ok = match workspace.get("workspace_id") {
        Some(Value::String(id)) => {
            (1..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_digit())
        }
        Some(Value::Number(n)) => n
            .as_f64()
            .is_some_and(|n| n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0),
        _ => false,
    };
    if !id_ok {
        return None;
    }
    let group = workspace.get("op_group_id")?.as_str()?;
    ((1..=128).contains(&group.len())
        && group
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then(|| group.to_owned())
}

/// v1 `quotaWindows` (minimaxCodeAccountQuota.ts:165-213): MCode reads the first row as its shared
/// 5-hour and weekly text plan.
fn quota_windows(payload: Option<&Json>) -> Vec<UsageWindow> {
    let Some(payload) = payload else {
        return Vec::new();
    };
    if record(payload.get("base_resp"))
        .and_then(|b| b.get("status_code"))
        .and_then(Value::as_f64)
        != Some(0.0)
    {
        return Vec::new();
    }
    let Some(model) = payload
        .get("model_remains")
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    for (key, kind, label, reset, duration) in [
        ("current_interval", "session", "5h", "end_time", 300),
        (
            "current_weekly",
            "weekly",
            "Weekly",
            "weekly_end_time",
            10080,
        ),
    ] {
        if model.get(&format!("{key}_status")).and_then(Value::as_f64) == Some(3.0) {
            continue; // Unlimited.
        }
        let total = model
            .get(&format!("{key}_total_count"))
            .and_then(Value::as_f64);
        // In the legacy payload, usage_count is the remaining quantity, not used.
        let count = model
            .get(&format!("{key}_usage_count"))
            .and_then(Value::as_f64);
        let from_counts = match (total, count) {
            (Some(total), Some(count))
                if total.is_finite()
                    && total > 0.0
                    && count.is_finite()
                    && count >= 0.0
                    && count <= total =>
            {
                Some(count / total * 100.0)
            }
            _ => None,
        };
        let remaining = match model.get(&format!("{key}_remaining_percent")) {
            None | Some(Value::Null) => from_counts,
            Some(value) => value.as_f64(),
        };
        let Some(remaining) = remaining.filter(|r| r.is_finite() && (0.0..=100.0).contains(r))
        else {
            continue;
        };
        let resets_at = model
            .get(reset)
            .and_then(Value::as_f64)
            .filter(|end| *end > 0.0)
            .map(|end| crate::items::rfc3339_ms(end as i64));
        windows.push(UsageWindow {
            id: kind.into(),
            kind: kind.into(),
            label: label.into(),
            used_percent: 100.0 - remaining,
            window_duration_mins: duration,
            resets_at,
        });
    }
    windows
}

/// v1 `makeMiniMaxCodeQuotaReader` (minimaxCodeAccountQuota.ts:231-306). It remembers the account
/// of its last reading so a failed read for that account keeps it.
pub struct MiniMaxCodeQuotaReader {
    http: Arc<dyn QuotaHttp>,
    uid: Option<u32>,
    last_account: Mutex<Option<String>>,
}

impl MiniMaxCodeQuotaReader {
    pub fn new(http: Arc<dyn QuotaHttp>) -> Self {
        #[cfg(unix)]
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = Some(unsafe { libc::getuid() });
        #[cfg(not(unix))]
        let uid = None;
        Self {
            http,
            uid,
            last_account: Mutex::new(None),
        }
    }

    fn unread(&self, account: &Mutex<Option<String>>) -> QuotaReading {
        let account = account.lock().expect("account").clone();
        let mut last = self.last_account.lock().expect("last account");
        if account.is_some() && account == *last {
            return QuotaReading::KeepLast;
        }
        *last = None;
        QuotaReading::SignedOut
    }

    /// Read the quota of the MiniMax Code profile that `env` and `args` launch.
    pub async fn read(&self, env: &BTreeMap<String, String>, args: &[String]) -> QuotaReading {
        let account = Mutex::new(None::<String>);
        let (Some(root), Some(uid)) = (profile_root(env, args), self.uid) else {
            return self.unread(&account);
        };
        let now = crate::items::now_ms();
        let configured = env.get("MAVIS_REGION").cloned();
        let work = async {
            // canonicalize also handles operating system aliases such as /var on macOS; a
            // symlinked data directory would change the account key.
            if std::fs::canonicalize(&root).ok().as_deref() != Some(root.as_path()) {
                return None;
            }
            let selected = choose_region(&root, uid, configured.as_deref())?;
            let login = read_login(&root, uid, selected, now)?;
            *account.lock().expect("account") = Some(format!(
                "{}\0{selected}\0{}",
                root.display(),
                login.generation
            ));
            let still_signed_in = || {
                choose_region(&root, uid, configured.as_deref()) == Some(selected)
                    && read_login(&root, uid, selected, now).is_some_and(|current| {
                        current.token == login.token && current.generation == login.generation
                    })
            };
            let (account_origin, quota_origin) = origins(selected);
            let authorization = format!("Bearer {}", login.token);
            // Private MiniMax routes observed in MCode. Do not invent a group ID or try
            // unrelated endpoints: an unproven personal workspace must show no quota.
            let identity = self
                .http
                .send(QuotaRequest {
                    method: "POST",
                    url: format!("{account_origin}/matrix/api/v1/user/get_user_extra_info"),
                    headers: vec![
                        ("Accept".into(), "application/json".into()),
                        ("Authorization".into(), authorization.clone()),
                        ("Content-Type".into(), "application/json".into()),
                    ],
                    body: Some("{}".into()),
                })
                .await;
            let group = personal_group(bounded_json(identity).as_ref())?;
            if !still_signed_in() {
                return None;
            }
            let response = self
                .http
                .send(QuotaRequest {
                    method: "GET",
                    url: format!("{quota_origin}/v1/api/openplatform/coding_plan/remains"),
                    headers: vec![
                        ("Accept".into(), "application/json".into()),
                        ("Authorization".into(), authorization),
                        ("X-Group-Id".into(), group),
                    ],
                    body: None,
                })
                .await;
            let windows = quota_windows(bounded_json(response).as_ref());
            // Discard responses that raced an account/region change or token rotation.
            if windows.is_empty() || !still_signed_in() {
                return None;
            }
            Some(windows)
        };
        match tokio::time::timeout(READ_TIMEOUT, work).await {
            Ok(Some(windows)) => {
                *self.last_account.lock().expect("last account") =
                    account.lock().expect("account").clone();
                QuotaReading::Reading(UsageLimits {
                    checked_at: crate::items::rfc3339_ms(now),
                    windows,
                })
            }
            _ => self.unread(&account),
        }
    }
}

/// One variable of the instance environment as provider settings hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceVariable {
    pub name: String,
    pub value: String,
    /// v1 `sensitive`, `secret` or `valueRedacted`.
    pub sensitive: bool,
}

/// v1 `hasExplicitMiniMaxQuotaProfile` (minimaxCodeUsageEnrichment.ts:7-35).
pub fn has_explicit_quota_profile(environment: Option<&[InstanceVariable]>) -> bool {
    let Some(environment) = environment else {
        return false;
    };
    let safe_literal = |v: &InstanceVariable| {
        !v.sensitive && !v.value.trim().is_empty() && v.value.trim() == v.value
    };
    let directories: Vec<&InstanceVariable> = environment
        .iter()
        .filter(|v| v.name == "MINIMAX_DATA_DIR")
        .collect();
    let regions: Vec<&InstanceVariable> = environment
        .iter()
        .filter(|v| v.name == "MAVIS_REGION")
        .collect();
    if directories.len() != 1
        || !safe_literal(directories[0])
        || !directories[0].value.starts_with('/')
    {
        return false;
    }
    // An inherited launch region or MCode's own preference may select the region inside this
    // explicit profile; ambiguous provider overrides are not accepted.
    regions.is_empty()
        || (regions.len() == 1
            && safe_literal(regions[0])
            && matches!(regions[0].value.as_str(), "en" | "cn"))
}

/// v1 `makeMiniMaxCodeUsageEnrichment` gate (minimaxCodeUsageEnrichment.ts:37-48).
pub fn quota_enrichment_enabled(
    settings: &RegistrySettings,
    environment: Option<&[InstanceVariable]>,
) -> bool {
    settings.enabled
        && settings.read_mini_max_code_quota
        && settings.is_minimax_code()
        && has_explicit_quota_profile(environment)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    struct FakeHttp {
        requests: Mutex<Vec<QuotaRequest>>,
        identity: Value,
        quota: Value,
    }

    #[async_trait]
    impl QuotaHttp for FakeHttp {
        async fn send(&self, request: QuotaRequest) -> Option<QuotaResponse> {
            let body = if request.url.ends_with("get_user_extra_info") {
                self.identity.clone()
            } else {
                self.quota.clone()
            };
            self.requests.lock().unwrap().push(request);
            Some(QuotaResponse {
                ok: true,
                content_length: None,
                body: Some(body.to_string().into_bytes()),
            })
        }
    }

    fn private_dir(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    fn private_file(path: &Path, value: &Value, mode: u32) {
        std::fs::write(path, value.to_string()).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn profile(root: &Path, token: &str, mode: u32) {
        private_dir(root);
        private_dir(&root.join("preferences"));
        private_file(
            &root.join("preferences/mcode-region.json"),
            &json!({"version": 1, "regions": {"prod": "en"}}),
            0o600,
        );
        let dir = root.join("auth/prod/en").join(CLIENT);
        for d in [
            root.join("auth"),
            root.join("auth/prod"),
            root.join("auth/prod/en"),
            dir.clone(),
        ] {
            private_dir(&d);
        }
        let expires = crate::items::now_ms() + 3_600_000;
        private_file(
            &dir.join("auth-state.json"),
            &json!({"schemaVersion": 2, "status": "authenticated", "storeKind": "file", "buildEnv": "prod",
                    "region": "en", "clientId": CLIENT, "audience": AUDIENCE, "generation": 7, "expiresAtMs": expires}),
            mode,
        );
        let mut hasher = Sha256::new();
        hasher.update(root.join("auth").to_string_lossy().as_bytes());
        hasher.update(b"\0");
        hasher.update(CLIENT.as_bytes());
        let account = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
        let key = format!("com.minimax.mcode.oauth.prod.en\0{account}");
        private_file(
            &dir.join("auth.json"),
            &json!({"schemaVersion": 1, "records": {key: {"schemaVersion": 1, "clientId": CLIENT, "audience": AUDIENCE,
                    "tokenType": "Bearer", "generation": 7, "expiresAtMs": expires, "accessToken": token}}}),
            0o600,
        );
    }

    fn fake(quota: Value) -> Arc<FakeHttp> {
        Arc::new(FakeHttp {
            requests: Mutex::new(Vec::new()),
            identity: json!({"base_resp": {"status_code": 0}, "data": {"workspaces": [
                {"workspace_type": 0, "workspace_id": "123", "op_group_id": "grp_1"},
                {"workspace_type": 1, "workspace_id": "9", "op_group_id": "team"}
            ]}}),
            quota,
        })
    }

    fn quota() -> Value {
        json!({"base_resp": {"status_code": 0}, "model_remains": [{
            "current_interval_remaining_percent": 75, "end_time": 1_800_000_000_000_i64,
            "current_weekly_total_count": 200, "current_weekly_usage_count": 50
        }]})
    }

    #[tokio::test]
    async fn reads_windows_for_the_signed_in_personal_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("profile");
        profile(&root, "tok.en-1", 0o600);
        let http = fake(quota());
        let reader = MiniMaxCodeQuotaReader::new(http.clone());
        let env = BTreeMap::from([(
            "MINIMAX_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        let reading = reader.read(&env, &["acp".into()]).await;
        let QuotaReading::Reading(limits) = reading else {
            panic!("{reading:?}");
        };
        assert_eq!(limits.windows.len(), 2);
        assert_eq!(limits.windows[0].kind, "session");
        assert_eq!(limits.windows[0].used_percent, 25.0);
        assert_eq!(
            limits.windows[0].resets_at.as_deref(),
            Some("2027-01-15T08:00:00.000Z")
        );
        assert_eq!(limits.windows[1].used_percent, 75.0);
        let requests = http.requests.lock().unwrap().clone();
        assert_eq!(
            requests[0].url,
            "https://agent.minimax.io/matrix/api/v1/user/get_user_extra_info"
        );
        assert!(
            requests[0]
                .headers
                .contains(&("Authorization".into(), "Bearer tok.en-1".into()))
        );
        assert!(
            requests[1]
                .headers
                .contains(&("X-Group-Id".into(), "grp_1".into()))
        );

        // A failed read for the same account keeps the last reading.
        let failing = MiniMaxCodeQuotaReader {
            http: fake(json!({"base_resp": {"status_code": 1}})),
            uid: reader.uid,
            last_account: Mutex::new(reader.last_account.lock().unwrap().clone()),
        };
        assert_eq!(
            failing.read(&env, &["acp".into()]).await,
            QuotaReading::KeepLast
        );
        assert_eq!(
            failing.read(&env, &["acp".into()]).await,
            QuotaReading::KeepLast
        );
        // Another launch is not the profile: signed out, and the remembered account is dropped.
        assert_eq!(
            failing.read(&env, &["chat".into()]).await,
            QuotaReading::SignedOut
        );
        assert_eq!(
            failing.read(&env, &["acp".into()]).await,
            QuotaReading::SignedOut
        );
    }

    #[tokio::test]
    async fn refuses_files_others_can_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap().join("profile");
        profile(&root, "tok", 0o644);
        let http = fake(quota());
        let reader = MiniMaxCodeQuotaReader::new(http.clone());
        let env = BTreeMap::from([(
            "MINIMAX_DATA_DIR".into(),
            root.to_string_lossy().into_owned(),
        )]);
        assert_eq!(
            reader.read(&env, &["acp".into()]).await,
            QuotaReading::SignedOut
        );
        assert!(http.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn profile_rules_match_v1() {
        let env = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            profile_root(
                &env(&[("MINIMAX_DATA_DIR", "/a/./b/../c")]),
                &["acp".into()]
            ),
            Some(PathBuf::from("/a/c"))
        );
        assert_eq!(
            profile_root(&env(&[("MINIMAX_DATA_DIR", "rel")]), &["acp".into()]),
            None
        );
        assert_eq!(
            profile_root(
                &env(&[("MINIMAX_DATA_DIR", "/a"), ("MAVIS_BUILD_ENV", "staging")]),
                &["acp".into()]
            ),
            None
        );
        let var = |name: &str, value: &str| InstanceVariable {
            name: name.into(),
            value: value.into(),
            sensitive: false,
        };
        assert!(has_explicit_quota_profile(Some(&[var(
            "MINIMAX_DATA_DIR",
            "/p"
        )])));
        assert!(has_explicit_quota_profile(Some(&[
            var("MINIMAX_DATA_DIR", "/p"),
            var("MAVIS_REGION", "cn")
        ])));
        assert!(!has_explicit_quota_profile(Some(&[
            var("MINIMAX_DATA_DIR", "/p"),
            var("MAVIS_REGION", "us")
        ])));
        assert!(!has_explicit_quota_profile(Some(&[var(
            "MINIMAX_DATA_DIR",
            "p"
        )])));
        assert!(!has_explicit_quota_profile(Some(&[InstanceVariable {
            sensitive: true,
            ..var("MINIMAX_DATA_DIR", "/p")
        }])));
        assert!(!has_explicit_quota_profile(None));
        let settings = RegistrySettings {
            source: crate::registry::index::Source::Local,
            command_path: "/usr/local/bin/mcode".into(),
            command_args: vec!["acp".into()],
            read_mini_max_code_quota: true,
            ..Default::default()
        };
        assert!(quota_enrichment_enabled(
            &settings,
            Some(&[var("MINIMAX_DATA_DIR", "/p")])
        ));
    }
}

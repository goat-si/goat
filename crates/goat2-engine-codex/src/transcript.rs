//! Recorded sessions in GOAT v1's replay transcript format (`packages/effect-codex-app-server/src/
//! replay.ts`): entries `expect_outbound` / `emit_inbound` / `runtime_exit`. Also the frame
//! matcher the fake codex uses, the recorder tap, the fail-closed redactor applied before a real
//! session is written to a public repository, and the privacy scan.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::protocol::methods;
use crate::transport::{Direction, Tap};

/// A whole recorded session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub provider: String,
    pub protocol: String,
    pub version: String,
    pub scenario: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    pub entries: Vec<Entry>,
}

impl Transcript {
    pub fn new(scenario: impl Into<String>) -> Self {
        Self {
            provider: "codex".into(),
            protocol: "codex.app-server".into(),
            version: crate::CODEX_SCHEMA_VERSION.into(),
            scenario: scenario.into(),
            metadata: None,
            entries: Vec::new(),
        }
    }

    /// Transcript-wide wildcards from `metadata.wildcards`.
    pub fn wildcards(&self) -> Vec<String> {
        self.metadata
            .as_ref()
            .and_then(|m| m.get("wildcards"))
            .and_then(|w| serde_json::from_value(w.clone()).ok())
            .unwrap_or_default()
    }
}

/// One step of a transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Entry {
    ExpectOutbound {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        frame: Value,
        /// GOAT extension: exact pointers in this frame the redactor changed.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        wildcards: Vec<String>,
    },
    EmitInbound {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        frame: Value,
        #[serde(default, rename = "afterMs", skip_serializing_if = "Option::is_none")]
        after_ms: Option<u64>,
    },
    RuntimeExit {
        status: ExitKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitKind {
    Success,
    Error,
    Cancelled,
}

/// A value check used instead of equality.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Shape {
    /// `http://127.0.0.1:<port>/...`.
    LoopbackUrl,
    /// `Bearer ` + at least 16 chars of `[A-Za-z0-9._~+/=-]`.
    BearerToken,
}

impl Shape {
    pub fn check(self, value: &Value) -> bool {
        let Some(text) = value.as_str() else {
            return false;
        };
        match self {
            Self::LoopbackUrl => {
                let Some(rest) = text.strip_prefix("http://127.0.0.1:") else {
                    return false;
                };
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                !digits.is_empty() && rest[digits.len()..].starts_with('/')
            }
            Self::BearerToken => text.strip_prefix("Bearer ").is_some_and(|token| {
                token.len() >= 16
                    && token
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._~+/=-".contains(c))
            }),
        }
    }
}

/// The pointer GOAT puts the MCP server URL at, inside `thread/start` / `thread/resume` frames.
pub const MCP_URL_POINTER: &str = "/params/config/mcp_servers.goat/url";
/// The pointer of the MCP bearer header.
pub const MCP_AUTH_POINTER: &str = "/params/config/mcp_servers.goat/http_headers/Authorization";

/// How an expected outbound frame is compared with the one GOAT sent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchRules {
    /// Pointer patterns (`*` = any one segment) whose values are ignored.
    pub wildcards: Vec<String>,
    /// Pointers whose values must have a shape instead of being equal.
    pub shapes: Vec<(String, Shape)>,
}

impl MatchRules {
    /// The defaults every transcript gets, plus its own wildcards.
    pub fn for_transcript(transcript: &Transcript) -> Self {
        let mut wildcards = vec![
            "/params/clientInfo/version".to_string(),
            "/params/cwd".to_string(),
            "/params/clientUserMessageId".to_string(),
        ];
        wildcards.extend(transcript.wildcards());
        Self {
            wildcards,
            shapes: vec![
                (MCP_URL_POINTER.to_string(), Shape::LoopbackUrl),
                (MCP_AUTH_POINTER.to_string(), Shape::BearerToken),
            ],
        }
    }

    pub fn with_extra_wildcards(&self, extra: &[String]) -> Self {
        let mut rules = self.clone();
        rules.wildcards.extend(extra.iter().cloned());
        rules
    }
}

/// Where two frames differ.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("mismatch at {pointer}: expected {expected}, got {actual}")]
pub struct Mismatch {
    pub pointer: String,
    pub expected: String,
    pub actual: String,
}

/// Compare an expected outbound frame with the actual one. The top-level `id` of a request (a
/// frame with `method`) is not compared (the caller binds it); the `id` of a response is.
pub fn frames_match(expected: &Value, actual: &Value, rules: &MatchRules) -> Result<(), Mismatch> {
    let is_request = expected.get("method").is_some();
    let mut path = Vec::new();
    compare(expected, actual, rules, &mut path, is_request)
}

fn pointer_of(path: &[String]) -> String {
    let mut out = String::new();
    for segment in path {
        out.push('/');
        out.push_str(&segment.replace('~', "~0").replace('/', "~1"));
    }
    out
}

fn pattern_matches(pattern: &str, path: &[String]) -> bool {
    let segments: Vec<String> = pattern
        .split('/')
        .skip(1)
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect();
    segments.len() == path.len()
        && segments
            .iter()
            .zip(path)
            .all(|(pattern, segment)| pattern == "*" || pattern == segment)
}

fn compare(
    expected: &Value,
    actual: &Value,
    rules: &MatchRules,
    path: &mut Vec<String>,
    skip_top_id: bool,
) -> Result<(), Mismatch> {
    if rules.wildcards.iter().any(|w| pattern_matches(w, path)) {
        return Ok(());
    }
    if let Some((_, shape)) = rules.shapes.iter().find(|(p, _)| pattern_matches(p, path)) {
        return if shape.check(actual) {
            Ok(())
        } else {
            Err(mismatch(path, &format!("{shape:?}"), actual))
        };
    }
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for (key, e_value) in e {
                if skip_top_id && path.is_empty() && key == "id" {
                    continue;
                }
                path.push(key.clone());
                let a_value = a.get(key).unwrap_or(&Value::Null);
                if !a.contains_key(key) && !rules.wildcards.iter().any(|w| pattern_matches(w, path)) {
                    let err = mismatch(path, &e_value.to_string(), &Value::Null);
                    path.pop();
                    return Err(Mismatch { actual: "<missing>".into(), ..err });
                }
                compare(e_value, a_value, rules, path, false)?;
                path.pop();
            }
            for key in a.keys() {
                if skip_top_id && path.is_empty() && key == "id" {
                    continue;
                }
                if !e.contains_key(key) {
                    path.push(key.clone());
                    let wild = rules.wildcards.iter().any(|w| pattern_matches(w, path));
                    let err = mismatch(path, "<missing>", &a[key]);
                    path.pop();
                    if !wild {
                        return Err(err);
                    }
                }
            }
            Ok(())
        }
        (Value::Array(e), Value::Array(a)) => {
            if e.len() != a.len() {
                return Err(mismatch(path, &format!("{} items", e.len()), &Value::from(format!("{} items", a.len()))));
            }
            for (index, (e_item, a_item)) in e.iter().zip(a).enumerate() {
                path.push(index.to_string());
                compare(e_item, a_item, rules, path, false)?;
                path.pop();
            }
            Ok(())
        }
        _ if expected == actual => Ok(()),
        _ => Err(mismatch(path, &expected.to_string(), actual)),
    }
}

fn mismatch(path: &[String], expected: &str, actual: &Value) -> Mismatch {
    Mismatch {
        pointer: pointer_of(path),
        expected: expected.to_string(),
        actual: actual.to_string(),
    }
}

/// Collects every frame from a connection tap.
#[derive(Clone)]
pub struct Recorder {
    inner: Arc<Mutex<RecorderState>>,
}

struct RecorderState {
    started: Instant,
    last_inbound: Option<Instant>,
    entries: Vec<Entry>,
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RecorderState {
                started: Instant::now(),
                last_inbound: None,
                entries: Vec::new(),
            })),
        }
    }

    pub fn tap(&self) -> Tap {
        let inner = Arc::clone(&self.inner);
        Arc::new(move |direction, frame| {
            let Ok(mut state) = inner.lock() else {
                return;
            };
            let now = Instant::now();
            let entry = match direction {
                Direction::Outbound => Entry::ExpectOutbound {
                    label: None,
                    frame: frame.clone(),
                    wildcards: Vec::new(),
                },
                Direction::Inbound => {
                    let since = state.last_inbound.unwrap_or(state.started);
                    state.last_inbound = Some(now);
                    Entry::EmitInbound {
                        label: None,
                        frame: frame.clone(),
                        after_ms: Some(now.duration_since(since).as_millis() as u64),
                    }
                }
            };
            state.entries.push(entry);
        })
    }

    /// Mark a point in time (e.g. after an outbound frame) so the next inbound delay is measured
    /// from it.
    pub fn finish(&self, scenario: &str, exit: Option<ExitKind>) -> Transcript {
        let mut transcript = Transcript::new(scenario);
        if let Ok(state) = self.inner.lock() {
            transcript.entries = state.entries.clone();
        }
        if let Some(status) = exit {
            transcript.entries.push(Entry::RuntimeExit { status, error: None });
        }
        transcript
    }
}

/// How the redactor treats a string value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldRule {
    Keep,
    Id,
    Path,
    Text,
}

/// Keys whose string values are protocol values or synthetic text the recorder wrote.
const KEEP_KEYS: &[&str] = &[
    "type", "status", "method", "phase", "decision", "model", "modelProvider", "mode", "action",
    "kind", "sortDirection", "itemsView", "approvalPolicy", "sandbox", "source", "effort",
    "reasoningEffort", "serviceTier", "approvalsReviewer", "name", "title", "version", "jsonrpc",
    "text", "delta", "command", "step", "platformOs", "platformFamily", "tool", "server",
    "multiAgentMode", "historyMode", "optOutNotificationMethods", "activeFlags",
    "availableDecisions", "execpolicy_amendment", "proposedExecpolicyAmendment", "environmentId",
];
/// Keys holding identifiers.
const ID_KEYS: &[&str] = &[
    "id", "threadId", "turnId", "itemId", "approvalId", "requestId", "clientUserMessageId",
    "clientId", "expectedTurnId", "senderThreadId", "receiverThreadIds", "agentThreadId",
    "sessionId", "processId",
];
/// Keys holding filesystem paths.
const PATH_KEYS: &[&str] = &[
    "cwd", "path", "codexHome", "savedPath", "instructionSources", "agentPath", "rolloutPath",
    "move_path", "scriptPath",
];
/// Keys whose whole subtree is always text-redacted, whatever the keys inside are called.
const REDACT_SUBTREE_KEYS: &[&str] = &[
    "aggregatedOutput", "result", "contentItems", "arguments", "error", "additionalDetails",
    "userAgent", "preview", "instructions", "baseInstructions", "developerInstructions",
    "permissions", "reason", "networkApprovalContext", "diff", "results",
    "tokenUsage", "gitInfo", "memoryCitation", "questions", "message",
];

/// Notification methods kept in recordings; every other notification is dropped.
const KEPT_NOTIFICATIONS: &[&str] = &[
    methods::ERROR,
    methods::THREAD_STARTED,
    methods::THREAD_STATUS_CHANGED,
    methods::THREAD_CLOSED,
    methods::TURN_STARTED,
    methods::TURN_COMPLETED,
    methods::TURN_PLAN_UPDATED,
    methods::ITEM_STARTED,
    methods::ITEM_COMPLETED,
    methods::AGENT_MESSAGE_DELTA,
    methods::PLAN_DELTA,
    methods::REASONING_SUMMARY_DELTA,
    methods::COMMAND_OUTPUT_DELTA,
    methods::SERVER_REQUEST_RESOLVED,
];
/// Request methods (both directions) kept in recordings.
const KEPT_REQUESTS: &[&str] = &[
    methods::INITIALIZE,
    methods::INITIALIZED,
    methods::THREAD_START,
    methods::THREAD_RESUME,
    methods::THREAD_TURNS_LIST,
    methods::TURN_START,
    methods::TURN_STEER,
    methods::TURN_INTERRUPT,
    methods::COMMAND_APPROVAL,
    methods::FILE_CHANGE_APPROVAL,
    methods::PERMISSIONS_APPROVAL,
    methods::USER_INPUT,
    methods::ELICITATION,
];

/// The placeholder bearer token written into recordings.
pub const RECORDED_TOKEN: &str = "Bearer goat2-recorded-token-0000";

/// Why a recording cannot be written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RedactError {
    #[error("id field {pointer} holds a value that is not id-shaped")]
    NotAnId { pointer: String },
}

/// Fail-closed redaction of a recorded transcript.
#[derive(Debug, Default)]
pub struct Redactor {
    paths: HashMap<String, usize>,
    request_methods: HashMap<String, String>,
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The rule for a key, given whether an ancestor forces text redaction.
    pub fn rule_for(key: &str) -> FieldRule {
        if ID_KEYS.contains(&key) {
            FieldRule::Id
        } else if PATH_KEYS.contains(&key) {
            FieldRule::Path
        } else if KEEP_KEYS.contains(&key) {
            FieldRule::Keep
        } else {
            FieldRule::Text
        }
    }

    /// Redact a whole transcript: drop frames outside the driver subset, redact strings, add
    /// per-frame wildcards for every changed outbound pointer.
    pub fn redact(&mut self, transcript: &Transcript) -> Result<Transcript, RedactError> {
        let mut out = Transcript {
            entries: Vec::new(),
            ..transcript.clone()
        };
        for entry in &transcript.entries {
            match entry {
                Entry::ExpectOutbound { label, frame, .. } => {
                    if let (Some(id), Some(method)) = (frame.get("id"), frame.get("method").and_then(Value::as_str)) {
                        self.request_methods.insert(format!("out:{id}"), method.to_string());
                    }
                    let mut changed = Vec::new();
                    let mut frame = frame.clone();
                    self.redact_value(&mut frame, &mut Vec::new(), false, &mut changed)?;
                    if frame.pointer(MCP_AUTH_POINTER).is_some() {
                        if let Some(slot) = frame.pointer_mut(MCP_AUTH_POINTER) {
                            *slot = Value::String(RECORDED_TOKEN.into());
                        }
                    }
                    out.entries.push(Entry::ExpectOutbound {
                        label: label.clone(),
                        frame,
                        wildcards: changed,
                    });
                }
                Entry::EmitInbound { label, frame, after_ms } => {
                    if !self.keep_inbound(frame) {
                        continue;
                    }
                    let mut frame = frame.clone();
                    self.redact_value(&mut frame, &mut Vec::new(), false, &mut Vec::new())?;
                    out.entries.push(Entry::EmitInbound {
                        label: label.clone(),
                        frame,
                        after_ms: *after_ms,
                    });
                }
                Entry::RuntimeExit { .. } => out.entries.push(entry.clone()),
            }
        }
        Ok(out)
    }

    fn keep_inbound(&mut self, frame: &Value) -> bool {
        match (frame.get("id"), frame.get("method").and_then(Value::as_str)) {
            // Server request.
            (Some(_), Some(method)) => KEPT_REQUESTS.contains(&method),
            // Notification.
            (None, Some(method)) => KEPT_NOTIFICATIONS.contains(&method),
            // Response to one of GOAT's requests: kept when that request was kept.
            (Some(id), None) => self
                .request_methods
                .get(&format!("out:{id}"))
                .is_some_and(|method| KEPT_REQUESTS.contains(&method.as_str())),
            (None, None) => false,
        }
    }

    fn redact_value(
        &mut self,
        value: &mut Value,
        path: &mut Vec<String>,
        forced_text: bool,
        changed: &mut Vec<String>,
    ) -> Result<(), RedactError> {
        let key = path.last().cloned();
        // Array items inherit the rule of the array's key.
        let key = key
            .filter(|k| k.parse::<usize>().is_err())
            .or_else(|| path.iter().rev().find(|k| k.parse::<usize>().is_err()).cloned());
        match value {
            Value::Object(map) => {
                let keys: Vec<String> = map.keys().cloned().collect();
                for k in keys {
                    // The JSON-RPC envelope's own result / error members are not tool output.
                    let envelope = path.is_empty() && (k == "result" || k == "error");
                    let force =
                        forced_text || (!envelope && REDACT_SUBTREE_KEYS.contains(&k.as_str()));
                    path.push(k.clone());
                    if let Some(child) = map.get_mut(&k) {
                        self.redact_value(child, path, force, changed)?;
                    }
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter_mut().enumerate() {
                    path.push(index.to_string());
                    self.redact_value(item, path, forced_text, changed)?;
                    path.pop();
                }
            }
            Value::String(text) => {
                let pointer = pointer_of(path);
                if pointer == MCP_URL_POINTER || pointer == MCP_AUTH_POINTER {
                    return Ok(());
                }
                let rule = if forced_text {
                    FieldRule::Text
                } else {
                    key.as_deref().map(Self::rule_for).unwrap_or(FieldRule::Text)
                };
                let replacement = match rule {
                    FieldRule::Keep => None,
                    FieldRule::Id => {
                        if is_id_shaped(text) {
                            None
                        } else {
                            return Err(RedactError::NotAnId { pointer });
                        }
                    }
                    FieldRule::Path => {
                        let next = self.paths.len();
                        let n = *self.paths.entry(text.clone()).or_insert(next);
                        Some(format!("/redacted/{n}"))
                    }
                    FieldRule::Text => Some("<redacted>".to_string()),
                };
                if let Some(replacement) = replacement {
                    if *text != replacement {
                        *text = replacement;
                        changed.push(pointer);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// UUID (8-4-4-4-12 hex), a Codex item id (`<lowercase prefix>_<hex>` such as `msg_057f...`, or
/// `<lowercase prefix>-<uuid>` such as `exec-e216...`), or `[A-Za-z0-9_-]{1,40}`; integers are not
/// strings and are not checked.
pub fn is_id_shaped(text: &str) -> bool {
    is_uuid(text)
        || is_prefixed_hex(text)
        || is_prefixed_uuid(text)
        || (!text.is_empty()
            && text.len() <= 40
            && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
}

/// `<1-12 lowercase letters>-<uuid>`.
fn is_prefixed_uuid(text: &str) -> bool {
    text.split_once('-').is_some_and(|(prefix, rest)| {
        (1..=12).contains(&prefix.len())
            && prefix.chars().all(|c| c.is_ascii_lowercase())
            && is_uuid(rest)
    })
}

/// `<1-12 lowercase letters>_<8-64 lowercase hex>`.
fn is_prefixed_hex(text: &str) -> bool {
    let Some((prefix, hex)) = text.split_once('_') else {
        return false;
    };
    (1..=12).contains(&prefix.len())
        && prefix.chars().all(|c| c.is_ascii_lowercase())
        && (8..=64).contains(&hex.len())
        && hex.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Something a public recording must not contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub what: &'static str,
    pub excerpt: String,
}

/// Scan text for personal or secret material.
pub fn privacy_scan(text: &str, home: &Path, user: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    let mut flag = |what: &'static str, needle: &str| {
        if let Some(at) = text.find(needle) {
            let start = text[..at].char_indices().rev().nth(20).map_or(0, |(i, _)| i);
            let end = (at + needle.len() + 20).min(text.len());
            let end = (end..=text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
            findings.push(Finding {
                what,
                excerpt: text[start..end].to_string(),
            });
        }
    };
    let home = home.to_string_lossy();
    if home.len() > 1 {
        flag("home directory", &home);
    }
    if user.len() >= 3 {
        flag("user name", user);
    }
    for needle in ["/Users/", "/home/", "/var/folders/", "/private/var/"] {
        flag("path marker", needle);
    }
    // API keys (sk-...) and JWTs (eyJ...) at a word start, followed by a long token.
    for prefix in ["sk-", "eyJ"] {
        for (at, _) in text.match_indices(prefix) {
            let word_start = text[..at].chars().next_back().is_none_or(|c| !c.is_ascii_alphanumeric());
            let run = text[at + prefix.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
                .count();
            if word_start && run >= 16 {
                findings.push(Finding {
                    what: "credential",
                    excerpt: text[at..].chars().take(12).collect(),
                });
                break;
            }
        }
    }
    // Bearer followed by anything but the placeholder.
    let mut rest = text;
    while let Some(at) = rest.find("Bearer ") {
        let after = &rest[at..];
        if !after.starts_with(RECORDED_TOKEN) {
            findings.push(Finding {
                what: "bearer token",
                excerpt: after.chars().take(30).collect(),
            });
            break;
        }
        rest = &rest[at + 7..];
    }
    // Email-like strings.
    for (index, _) in text.match_indices('@') {
        let before = text[..index].chars().rev().take_while(|c| c.is_ascii_alphanumeric() || "._%+-".contains(*c)).count();
        let after: String = text[index + 1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || ".-".contains(*c))
            .collect();
        if before > 0 && after.contains('.') && !after.ends_with('.') {
            findings.push(Finding {
                what: "email address",
                excerpt: text[index.saturating_sub(before)..index + 1 + after.len()].to_string(),
            });
            break;
        }
    }
    // Long token-like runs (letters, digits, + = _ -) with at least 4 digits that are not a UUID
    // or a Codex item id. "/" separates runs so JSON pointers and paths are not tokens.
    let mut token = String::new();
    let check = |token: &str, findings: &mut Vec<Finding>| {
        if token.len() >= 32
            && !is_uuid(token)
            && !is_prefixed_hex(token)
            && !is_prefixed_uuid(token)
            && token.chars().filter(|c| c.is_ascii_digit()).count() >= 4
        {
            findings.push(Finding {
                what: "long token",
                excerpt: token.chars().take(40).collect(),
            });
        }
    };
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || "+=_-".contains(c) {
            token.push(c);
        } else {
            check(&token, &mut findings);
            token.clear();
        }
    }
    check(&token, &mut findings);
    findings
}

/// Canonical (sorted-key) JSON, for byte comparisons in tests.
pub fn canonical(value: &Value) -> String {
    fn sort(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let sorted: BTreeMap<_, _> = map.iter().map(|(k, v)| (k.clone(), sort(v))).collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    sort(value).to_string()
}

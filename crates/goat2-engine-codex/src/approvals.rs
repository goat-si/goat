//! Approval and question handling ported from GOAT v1.
use crate::contract::{
    ApprovalDecision, ApprovalOption, ItemId, NativeItemRef, NativeRefStrength,
    ProviderRequestKind, RequestId, RequestOutcome, RuntimeMode, ThreadId, TurnItem, TurnItemBody,
    TurnItemStatus, UserInputOption as ProjectedOption, UserInputQuestion as ProjectedQuestion,
};
use crate::protocol::server::{
    CommandApprovalParams, CommandDecision, FileChangeDecision, UserInputQuestion,
};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Debug, thiserror::Error)]
pub enum AnswerError {
    #[error("incompatible answer: {0}")]
    Mismatch(String),
}
fn valid(o: RequestOutcome) -> Result<RequestOutcome, AnswerError> {
    match o {
        RequestOutcome::Accept
        | RequestOutcome::AcceptForSession
        | RequestOutcome::AcceptAlways
        | RequestOutcome::Decline
        | RequestOutcome::Cancel => Ok(o),
        _ => Err(AnswerError::Mismatch(format!("{o:?}"))),
    }
}
fn nonempty(s: &str) -> Option<&str> {
    let s = s.trim();
    (!s.is_empty()).then_some(s)
}
fn joined(v: Vec<String>) -> Option<String> {
    (!v.is_empty()).then(|| v.join("\n"))
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:27-40
pub fn command_prompt(p: &CommandApprovalParams) -> Option<String> {
    let mut v = Vec::new();
    if let Some(s) = p.command.as_deref().filter(|s| nonempty(s).is_some()) {
        v.push(s.into())
    }
    if let Some(s) = p.cwd.as_deref().filter(|s| nonempty(s).is_some()) {
        v.push(format!("cwd {s}"))
    }
    if let Some(n) = &p.network_approval_context {
        v.push(format!(
            "network {} {}",
            n["protocol"].as_str().unwrap_or("undefined"),
            n["host"].as_str().unwrap_or("undefined")
        ))
    }
    joined(v)
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:8-25
pub fn file_change_prompt(changes: &[(String, Value)], grant_root: Option<&str>) -> Option<String> {
    let mut c = changes.to_vec();
    c.sort_by(|a, b| a.0.cmp(&b.0));
    let mut lines = Vec::new();
    for (p, k) in c {
        let t = k["type"].as_str().unwrap_or("undefined");
        let mut line = format!("{t} {p}");
        if t == "update"
            && let Some(m) = k["move_path"].as_str().filter(|s| !s.is_empty())
        {
            line.push_str(&format!(" -> {m}"));
        }
        lines.push(line);
    }
    if let Some(s) = grant_root.and_then(nonempty) {
        lines.push(format!("write {s}"));
    }
    joined(lines)
}
fn path_label(p: &Value) -> String {
    match p["type"].as_str() {
        Some("path") => p["path"].as_str().unwrap_or("").into(),
        Some("glob_pattern") => p["pattern"].as_str().unwrap_or("").into(),
        _ => {
            let v = &p["value"];
            match v["kind"].as_str() {
                Some("root") => "/ (entire filesystem)".into(),
                Some("slash_tmp") => "/tmp".into(),
                Some("tmpdir") => "temporary directory".into(),
                Some("minimal") => "minimal system paths".into(),
                _ => {
                    let first = if v["kind"] == "project_roots" {
                        "project roots"
                    } else {
                        v["path"].as_str().unwrap_or("")
                    };
                    let s = [first, v["subpath"].as_str().unwrap_or("")]
                        .into_iter()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("/");
                    if s.is_empty() {
                        "unknown path".into()
                    } else {
                        s
                    }
                }
            }
        }
    }
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:43-78
pub fn permissions_prompt(p: &Value) -> Option<String> {
    let mut lines = Vec::new();
    let fs = &p["fileSystem"];
    for access in ["read", "write"] {
        if let Some(a) = fs[access].as_array() {
            for path in a {
                if let Some(s) = path.as_str() {
                    let l = format!("{access} {s}");
                    if !lines.contains(&l) {
                        lines.push(l)
                    }
                }
            }
        }
    }
    if let Some(a) = fs["entries"].as_array() {
        for e in a {
            let l = format!(
                "{} {}",
                e["access"].as_str().unwrap_or("undefined"),
                path_label(&e["path"])
            );
            if !lines.contains(&l) {
                lines.push(l)
            }
        }
    }
    if p["network"]["enabled"] == true {
        lines.push("network".into())
    }
    joined(lines)
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:96-109
pub fn request_kind_from_permissions(p: &Value) -> ProviderRequestKind {
    let fs = &p["fileSystem"];
    for (s, k) in [
        ("write", ProviderRequestKind::FileChange),
        ("read", ProviderRequestKind::FileRead),
    ] {
        if fs[s].as_array().is_some_and(|a| !a.is_empty())
            || fs["entries"]
                .as_array()
                .is_some_and(|a| a.iter().any(|e| e["access"] == s))
        {
            return k;
        }
    }
    ProviderRequestKind::Command
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexFullAccessApproval.ts:3-16
pub fn full_access_accepts_command(mode: RuntimeMode, p: &CommandApprovalParams) -> bool {
    mode == RuntimeMode::FullAccess
        && p.network_approval_context.is_none()
        && p.proposed_network_policy_amendments
            .as_ref()
            .is_none_or(Vec::is_empty)
}
#[derive(Default)]
pub struct SessionAllowance {
    mode: Option<RuntimeMode>,
    kinds: HashSet<ProviderRequestKind>,
}
impl SessionAllowance {
    // GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1150-1170
    pub fn kinds_for(&mut self, mode: RuntimeMode) -> &mut HashSet<ProviderRequestKind> {
        if self.mode != Some(mode) {
            self.kinds.clear();
            self.mode = Some(mode)
        }
        &mut self.kinds
    }
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4906-4920
pub fn command_decision(o: RequestOutcome) -> Result<CommandDecision, AnswerError> {
    Ok(match valid(o)? {
        RequestOutcome::Accept => CommandDecision::Accept,
        RequestOutcome::AcceptForSession | RequestOutcome::AcceptAlways => {
            CommandDecision::AcceptForSession
        }
        RequestOutcome::Decline => CommandDecision::Decline,
        RequestOutcome::Cancel => CommandDecision::Cancel,
        _ => unreachable!(),
    })
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4980-4994
pub fn file_change_decision(o: RequestOutcome) -> Result<FileChangeDecision, AnswerError> {
    Ok(match valid(o)? {
        RequestOutcome::Accept => FileChangeDecision::Accept,
        RequestOutcome::AcceptForSession | RequestOutcome::AcceptAlways => {
            FileChangeDecision::AcceptForSession
        }
        RequestOutcome::Decline => FileChangeDecision::Decline,
        RequestOutcome::Cancel => FileChangeDecision::Cancel,
        _ => unreachable!(),
    })
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4915-4920
pub fn records_session_allowance(o: RequestOutcome) -> bool {
    matches!(
        o,
        RequestOutcome::AcceptForSession | RequestOutcome::AcceptAlways
    )
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:111-125
pub fn permissions_response(o: RequestOutcome, p: &Value) -> Result<Value, AnswerError> {
    Ok(match valid(o)? {
        RequestOutcome::Accept => json!({"permissions":p,"scope":"turn"}),
        RequestOutcome::AcceptForSession => json!({"permissions":p,"scope":"session"}),
        _ => json!({"permissions":{},"scope":"turn"}),
    })
}
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => v.to_string(),
    }
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexApprovalResponses.ts:127-154
pub fn user_input_answers(answers: &Map<String, Value>, ids: &[(String, String)]) -> Value {
    let mut out = Map::new();
    for (key, v) in answers {
        if let Some((_, id)) = ids.iter().rev().find(|(k, _)| k == key) {
            let a: Vec<String> = match v {
                Value::Array(a) => a.iter().map(js_string).collect(),
                Value::Null => vec![],
                Value::Object(_) => vec![v.to_string()],
                _ => vec![js_string(v)],
            };
            out.insert(id.clone(), json!({"answers":a}));
        }
    }
    json!({"answers":out})
}

pub mod elicitation {
    use super::*;
    fn persistence(s: &str) -> Option<RequestOutcome> {
        let s = s.to_lowercase();
        if s.contains("session") {
            Some(RequestOutcome::AcceptForSession)
        } else if ["always", "permanent", "forever", "persistent"]
            .iter()
            .any(|w| s.contains(w))
        {
            Some(RequestOutcome::AcceptAlways)
        } else {
            None
        }
    }
    fn form(raw: &Value) -> Option<&Value> {
        let s = &raw["requestedSchema"];
        (raw["mode"] != "url"
            && s.is_object()
            && s.get("properties")
                .is_none_or(|v| v.as_object().is_some_and(|p| p.values().all(valid_field)))
            && s.get("required").is_none_or(string_array))
        .then_some(s)
    }
    fn string_array(v: &Value) -> bool {
        v.is_null() || v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
    }
    fn valid_field(v: &Value) -> bool {
        v.is_object()
            && ["type", "title", "description"]
                .iter()
                .all(|k| v.get(k).is_none_or(|v| v.is_null() || v.is_string()))
            && ["enum", "enumNames"]
                .iter()
                .all(|k| v.get(k).is_none_or(string_array))
            && v.get("oneOf").is_none_or(|v| {
                v.is_null()
                    || v.as_array().is_some_and(|a| {
                        a.iter().all(|o| {
                            o.is_object()
                                && o.get("const").is_some_and(Value::is_string)
                                && o.get("title").is_none_or(|t| t.is_null() || t.is_string())
                        })
                    })
            })
    }
    fn valid_metadata(m: &Value) -> bool {
        let strings = |v: &Value, keys: &[&str]| {
            v.is_object()
                && keys
                    .iter()
                    .all(|k| v.get(k).is_none_or(|x| x.is_null() || x.is_string()))
        };
        strings(
            m,
            &[
                "app",
                "app_name",
                "appName",
                "connector_name",
                "connectorName",
            ],
        ) && m
            .get("allowPersistentApproval")
            .is_none_or(|v| v.is_null() || v.is_boolean())
            && m.get("persist")
                .is_none_or(|v| v.is_null() || v.is_string() || string_array(v))
            && m.get("target")
                .is_none_or(|v| v.is_null() || strings(v, &["app", "name"]))
            && m.get("tool_params")
                .is_none_or(|v| v.is_null() || strings(v, &["app", "app_name"]))
    }
    fn options(field: &Value) -> Vec<(String, String)> {
        if let Some(a) = field["oneOf"].as_array() {
            return a
                .iter()
                .filter_map(|o| {
                    Some((
                        o["const"].as_str()?.into(),
                        o["title"].as_str().unwrap_or("").into(),
                    ))
                })
                .collect();
        }
        field["enum"]
            .as_array()
            .map(|a| {
                a.iter()
                    .enumerate()
                    .filter_map(|(i, v)| {
                        Some((
                            v.as_str()?.into(),
                            field["enumNames"][i].as_str().unwrap_or("").into(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    fn persist_field(k: &str, f: &Value) -> bool {
        persistence(k).is_some()
            || k.eq_ignore_ascii_case("persist")
            || persistence(f["title"].as_str().unwrap_or("")).is_some()
            || persistence(f["description"].as_str().unwrap_or("")).is_some()
    }
    fn once(s: &str) -> bool {
        let s = s.trim().to_lowercase();
        for prefix in ["once", "accept", "approve", "allow"] {
            if let Some(rest) = s.strip_prefix(prefix) {
                let r =
                    rest.trim_start_matches(|c: char| c == '_' || c == '-' || c.is_whitespace());
                fn suffix(s: &str) -> &str {
                    s.trim_start_matches(|c: char| c == '_' || c == '-' || c.is_whitespace())
                }
                if r.is_empty()
                    || r == "once"
                    || r.strip_prefix("once").is_some_and(|s| suffix(s) == "only")
                    || r.strip_prefix("this").is_some_and(|s| suffix(s) == "time")
                {
                    return true;
                }
            }
        }
        false
    }
    // GOAT v1 apps/server/src/provider/CodexMcpElicitation.ts:133-161
    pub fn auto_approve(raw: &Value) -> Value {
        let schema = &raw["requestedSchema"];
        let browser = json!({"type":"object","properties":{"approval":{"type":"string","enum":["once","always"]}},"required":["approval"]});
        let safari = json!({"type":"object","properties":{"approval":{"type":"string","oneOf":[{"const":"once","title":"Allow once"},{"const":"session","title":"Allow for this session"},{"const":"always","title":"Always allow Safari"}]}},"required":["approval"]});
        if raw["mode"] != "form" {
            return json!({"action":"cancel"});
        }
        if *schema == browser || *schema == safari {
            json!({"action":"accept","content":{"approval":"once"}})
        } else if *schema == json!({"type":"object","properties":{}})
            || *schema == json!({"type":"object","properties":{},"required":[]})
        {
            json!({"action":"accept","content":{}})
        } else {
            json!({"action":"cancel"})
        }
    }
    // GOAT v1 apps/server/src/provider/CodexMcpElicitation.ts:238-289
    pub fn response(raw: &Value, o: RequestOutcome) -> Result<Value, AnswerError> {
        let o = valid(o)?;
        if matches!(o, RequestOutcome::Decline | RequestOutcome::Cancel) {
            return Ok(json!({"action":if o==RequestOutcome::Decline {"decline"}else{"cancel"}}));
        }
        if raw["mode"] == "url" {
            return Ok(json!({"action":"decline"}));
        }
        let persist = match o {
            RequestOutcome::AcceptForSession => Some("session"),
            RequestOutcome::AcceptAlways => Some("always"),
            _ => None,
        };
        let f = form(raw);
        let mut content = Map::new();
        if let Some(props) = f.and_then(|v| v["properties"].as_object()) {
            for (k, field) in props {
                let found = options(field).into_iter().find(|(v, _)| {
                    if persist.is_some() {
                        persistence(v) == Some(o)
                    } else {
                        once(v) && persistence(v).is_none()
                    }
                });
                if let Some((v, _)) = found {
                    content.insert(k.clone(), json!(v));
                } else if field["type"] == "boolean" && persist_field(k, field) {
                    content.insert(k.clone(), json!(o == RequestOutcome::AcceptAlways));
                } else if let Some(v) = field.get("default").filter(|v| !v.is_null()) {
                    content.insert(k.clone(), v.clone());
                }
            }
        }
        if f.and_then(|v| v["required"].as_array()).is_some_and(|a| {
            a.iter()
                .any(|k| k.as_str().is_some_and(|s| !content.contains_key(s)))
        }) {
            return Ok(json!({"action":"decline"}));
        }
        let mut out = json!({"action":"accept"});
        if let Some(p) = persist {
            out["_meta"] = json!({"persist":p})
        }
        if f.is_some() {
            out["content"] = Value::Object(content)
        }
        Ok(out)
    }
    // GOAT v1 apps/server/src/provider/CodexMcpElicitation.ts:176-236
    pub fn describe(raw: &Value) -> (String, Vec<ApprovalOption>) {
        let m = if valid_metadata(&raw["_meta"]) {
            &raw["_meta"]
        } else {
            &Value::Null
        };
        let message = raw["message"].as_str().unwrap_or("");
        let prefix = "Allow ChatGPT to use ";
        let extracted = message
            .get(..prefix.len())
            .filter(|s| s.eq_ignore_ascii_case(prefix))
            .and_then(|_| message.get(prefix.len()..))
            .and_then(|s| s.strip_suffix('?'))
            .filter(|s| !s.is_empty() && !s.contains('\n'));
        let app = [
            m["app_name"].as_str(),
            m["appName"].as_str(),
            m["app"].as_str(),
            m["target"]["app"].as_str(),
            m["target"]["name"].as_str(),
            m["tool_params"]["app_name"].as_str(),
            m["tool_params"]["app"].as_str(),
            extracted,
            m["connector_name"].as_str(),
            m["connectorName"].as_str(),
            raw["serverName"].as_str(),
        ]
        .into_iter()
        .flatten()
        .next()
        .unwrap_or("")
        .to_owned();
        let mut session = None;
        let mut always = None;
        let mut add = |o: RequestOutcome, l: String| {
            if o == RequestOutcome::AcceptForSession {
                session = Some(l)
            } else {
                always = Some(l)
            }
        };
        let p = &m["persist"];
        let vals: Vec<&str> = if let Some(s) = p.as_str() {
            vec![s]
        } else {
            p.as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default()
        };
        for v in vals {
            if let Some(o) = persistence(v) {
                add(o, String::new())
            }
        }
        if m["allowPersistentApproval"] == true {
            add(RequestOutcome::AcceptAlways, String::new())
        }
        if let Some(props) = form(raw).and_then(|v| v["properties"].as_object()) {
            for (k, f) in props {
                for (v, l) in options(f) {
                    if let Some(o) = persistence(&v) {
                        add(o, l)
                    }
                }
                if f["type"] == "boolean" && persist_field(k, f) {
                    add(
                        RequestOutcome::AcceptAlways,
                        f["title"].as_str().unwrap_or("").into(),
                    )
                }
            }
        }
        let make = |decision, label: &str| ApprovalOption {
            decision,
            label: label.into(),
            warning: None,
        };
        let mut out = vec![
            make(ApprovalDecision::Cancel, "Cancel"),
            make(ApprovalDecision::Decline, "Decline"),
        ];
        for (l, o, d, default) in [
            (
                session,
                RequestOutcome::AcceptForSession,
                ApprovalDecision::AcceptForSession,
                "Always allow this session",
            ),
            (
                always,
                RequestOutcome::AcceptAlways,
                ApprovalDecision::AcceptAlways,
                "Always allow",
            ),
        ] {
            if let Some(l) = l
                && response(raw, o).is_ok_and(|v| v["action"] == "accept")
            {
                out.push(make(d, if l.is_empty() { default } else { &l }))
            }
        }
        out.push(make(ApprovalDecision::Accept, "Approve"));
        (app, out)
    }
}

pub struct WaitingCtx<'a> {
    pub thread_id: &'a ThreadId,
    pub turn_id: &'a str,
    pub native_item_id: &'a str,
    pub request_id: &'a RequestId,
    pub ordinal: u32,
    pub now_ms: i64,
}
// Convert Unix milliseconds to the v1 ISO-8601 UTC timestamp.
fn timestamp(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}
fn waiting(ctx: &WaitingCtx<'_>, id: ItemId, body: TurnItemBody) -> TurnItem {
    let t = timestamp(ctx.now_ms);
    TurnItem {
        id,
        thread_id: ctx.thread_id.clone(),
        run_id: None,
        provider_thread_id: None,
        provider_turn_id: Some(ctx.turn_id.into()),
        native_item_ref: Some(NativeItemRef {
            driver: "codex".into(),
            native_id: Some(ctx.native_item_id.into()),
            strength: NativeRefStrength::Strong,
            fingerprint: None,
            ordinal: None,
        }),
        parent_item_id: None,
        ordinal: ctx.ordinal,
        status: TurnItemStatus::Waiting,
        title: None,
        started_at: Some(t.clone()),
        completed_at: None,
        updated_at: t,
        body,
    }
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3576-3674
pub fn approval_item(
    ctx: &WaitingCtx<'_>,
    request_kind: ProviderRequestKind,
    prompt: Option<String>,
    reason: Option<&str>,
    _app_name: Option<String>,
    options: Option<Vec<ApprovalOption>>,
) -> TurnItem {
    waiting(
        ctx,
        ItemId::new(format!("approval:{}", ctx.request_id)),
        TurnItemBody::ApprovalRequest {
            request_id: ctx.request_id.clone(),
            request_kind,
            prompt,
            reason: reason.and_then(nonempty).map(str::to_owned),
            options,
        },
    )
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3676-3777
pub fn user_input_item(
    ctx: &WaitingCtx<'_>,
    questions: &[UserInputQuestion],
) -> (TurnItem, Vec<(String, String)>) {
    let mut ids = Vec::new();
    let q = questions
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let id = nonempty(&q.id)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("question-{}", i + 1));
            ids.push((id.clone(), q.id.clone()));
            ProjectedQuestion {
                id,
                header: nonempty(&q.header).unwrap_or("Question").into(),
                question: nonempty(&q.question).unwrap_or("Choose an answer.").into(),
                options: q
                    .options
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                    .map(|(i, o)| ProjectedOption {
                        label: nonempty(&o.label)
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("Option {}", i + 1)),
                        description: nonempty(&o.description).unwrap_or(&o.label).into(),
                        value: None,
                        preview: None,
                    })
                    .collect(),
                multi_select: None,
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            }
        })
        .collect();
    (
        waiting(
            ctx,
            ItemId::new(ctx.native_item_id),
            TurnItemBody::UserInputRequest {
                request_id: ctx.request_id.clone(),
                questions: q,
            },
        ),
        ids,
    )
}
// GOAT v1 apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3576-3777; GOAT 2 summary limit.
pub fn summary(item: &TurnItem) -> String {
    let s = match &item.body {
        TurnItemBody::ApprovalRequest {
            prompt,
            request_kind,
            ..
        } => prompt.clone().unwrap_or_else(|| {
            serde_json::to_value(request_kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        }),
        TurnItemBody::UserInputRequest { questions, .. } => questions
            .iter()
            .map(|q| q.question.as_str())
            .collect::<Vec<_>>()
            .join("; "),
        _ => String::new(),
    };
    s.chars().take(200).collect()
}

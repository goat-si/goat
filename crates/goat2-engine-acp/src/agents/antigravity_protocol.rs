//! Antigravity's ACP protocol fixes.
//!
//! v1 `apps/server/src/provider/acp/AntigravityProtocol.ts` at 916b5ccc1b2: approval choices with
//! the shell/web security warning (:148-195), `interaction_` permission requests as questions
//! (:128-133, :197-288), `ask_question` form headers (:211-239), tool payload bounds and session
//! update normalization (:43-46, :290-398, :482-549), the client-read repair (:401-480), the
//! `update_steps` checklist as plan updates (:738-790) and native command fields (:48-64,
//! :620-688, adapted to per-update JSON). Permission disposition with GOAT MCP auto-approval from
//! `AntigravityAcpSupport.ts:213-248`. Text bounds count chars where v1 counts UTF-16 units.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use goat2_contracts::{
    ApprovalDecision, ApprovalOption, RuntimeMode, UserInputOption, UserInputQuestion,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::elicitation::parse_elicitation_form;
use crate::flavor::{ExtRequest, NativeElicitationForm};
use crate::policy::{
    self, ACP_RAW_INPUT_PATH_KEYS, ChangedPaths, Disposition, RuntimePolicy,
    changed_paths_of_tool_call,
};

use super::antigravity_goat_tools::is_goat_mcp_tool;

const TOOL_TEXT_LIMIT: usize = 8_000;
const TOOL_TEXT_TRUNCATED: &str = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED: &str = "\n\n[Command truncated]";
const QUESTION_LABEL_LIMIT: usize = 512;
const SECURITY_WARNING_META_KEY: &str = "agy.security.warning";
const WARNING_TEXT_LIMIT: usize = 512;

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

fn head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn tail(text: &str, limit: usize) -> String {
    let skip = char_len(text).saturating_sub(limit);
    text.chars().skip(skip).collect()
}

/// v1 `boundText` (:290-294): keeps the tail of long text.
pub fn bound_text(text: &str, limit: usize) -> String {
    if char_len(text) <= limit {
        text.to_owned()
    } else {
        format!("{TOOL_TEXT_TRUNCATED}{}", tail(text, limit))
    }
}

/// v1 `boundCommandText` (:296-305).
fn bound_command_text(text: &str, limit: usize) -> String {
    let length = char_len(text);
    if length <= limit
        || (length <= limit + char_len(TOOL_TEXT_TRUNCATED)
            && text.starts_with(TOOL_TEXT_TRUNCATED))
    {
        return text.to_owned();
    }
    format!("{TOOL_TEXT_TRUNCATED}{}", tail(text, limit))
}

/// v1 `boundCommandLine` (:307-317): a command line keeps its head.
pub fn bound_command_line(text: &str, limit: usize) -> String {
    let length = char_len(text);
    if length <= limit
        || (length <= limit + char_len(COMMAND_LINE_TRUNCATED)
            && text.ends_with(COMMAND_LINE_TRUNCATED))
    {
        return text.to_owned();
    }
    format!("{}{COMMAND_LINE_TRUNCATED}", head(text, limit))
}

fn bound_question_text(text: &str, limit: usize) -> String {
    if char_len(text) <= limit {
        text.to_owned()
    } else {
        format!("{}...", head(text, limit - 3))
    }
}

/// v1 `isAntigravityUserInputRequest` (:128-133): native questions share the permission method.
pub fn is_user_input_request(request: &Value) -> bool {
    request
        .pointer("/toolCall/toolCallId")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("interaction_"))
}

fn options_of(request: &Value) -> Vec<Value> {
    request
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn option_id(option: &Value) -> &str {
    str_at(option, "optionId").unwrap_or_default()
}

/// v1 `antigravitySecurityWarning` (:158-168): Allow Always `_meta` warnings as option text.
fn security_warning(option: &Value) -> Option<String> {
    let warning = option.get("_meta")?.get(SECURITY_WARNING_META_KEY)?;
    let message = str_at(warning, "message")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let title = str_at(warning, "title")
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let text = message.or(title)?;
    Some(if char_len(text) > WARNING_TEXT_LIMIT {
        format!("{}...", head(text, WARNING_TEXT_LIMIT - 3))
    } else {
        text.to_owned()
    })
}

/// v1 `antigravityApprovalOptions` (:170-195).
pub fn approval_options(request: &Value) -> Vec<ApprovalOption> {
    if is_user_input_request(request) {
        return Vec::new();
    }
    let options = options_of(request);
    let with_kind = |kind: &str| {
        options
            .iter()
            .find(|o| str_at(o, "kind") == Some(kind) && !option_id(o).trim().is_empty())
    };
    let mut out = Vec::new();
    if with_kind("allow_once").is_some() {
        out.push(ApprovalOption {
            decision: ApprovalDecision::Accept,
            label: "Allow once".into(),
            warning: None,
        });
    }
    if let Some(always) = with_kind("allow_always") {
        out.push(ApprovalOption {
            decision: ApprovalDecision::AcceptForSession,
            label: "Allow for this thread".into(),
            warning: security_warning(always),
        });
    }
    if with_kind("reject_once").is_some() {
        out.push(ApprovalOption {
            decision: ApprovalDecision::Decline,
            label: "Deny".into(),
            warning: None,
        });
    }
    out.push(ApprovalOption {
        decision: ApprovalDecision::Cancel,
        label: "Cancel".into(),
        warning: None,
    });
    out
}

fn question_label(option: &Value) -> String {
    let name = str_at(option, "name").unwrap_or_default().trim();
    let label = if name.is_empty() {
        option_id(option)
    } else {
        name
    };
    bound_question_text(label, QUESTION_LABEL_LIMIT)
}

/// v1 `extractAntigravityUserInputQuestion` (:241-267).
pub fn user_input_question(request: &Value) -> Option<UserInputQuestion> {
    let options = options_of(request);
    if !is_user_input_request(request) || options.is_empty() {
        return None;
    }
    let mut ids = HashSet::new();
    for option in &options {
        let id = option_id(option);
        if id.trim().is_empty() || !ids.insert(id.to_owned()) {
            return None;
        }
    }
    let tool_call = request.get("toolCall").cloned().unwrap_or(Value::Null);
    let question = str_at(&tool_call, "title")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Choose an option.");
    Some(UserInputQuestion {
        id: str_at(&tool_call, "toolCallId")
            .unwrap_or_default()
            .to_owned(),
        header: "Question".into(),
        question: bound_question_text(question, TOOL_TEXT_LIMIT),
        options: options
            .iter()
            .map(|option| UserInputOption {
                label: question_label(option),
                description: question_label(option),
                value: Some(option_id(option).to_owned()),
                preview: None,
            })
            .collect(),
        multi_select: Some(false),
        allow_custom_answer: Some(false),
        initial_answer: None,
        required: None,
    })
}

/// v1 `makeAntigravityUserInputResponse` (:269-288): the chosen option by id, or by a label only
/// one option has.
pub fn user_input_response(request: &Value, answers: &Map<String, Value>) -> Option<Value> {
    let question = user_input_question(request)?;
    let value = match answers.get(&question.id)? {
        Value::String(s) => s.clone(),
        Value::Array(list) if list.len() == 1 => list[0].as_str()?.to_owned(),
        _ => return None,
    };
    let options = options_of(request);
    let selected = |id: &str| json!({"outcome": {"outcome": "selected", "optionId": id}});
    if let Some(exact) = options.iter().find(|o| option_id(o) == value) {
        return Some(selected(option_id(exact)));
    }
    let matching: Vec<&Value> = options
        .iter()
        .filter(|o| question_label(o) == value)
        .collect();
    (matching.len() == 1).then(|| selected(option_id(matching[0])))
}

/// v1 `extractPermissionQuestion` for Antigravity (AntigravityAdapterV2.ts:304-311): ask the
/// question and answer with the chosen option, cancelled when dismissed or unmatched
/// (adapter.ts:5141-5146).
pub fn permission_question(request: &Value) -> Option<ExtRequest> {
    let question = user_input_question(request)?;
    let request = request.clone();
    Some(ExtRequest::AskUser {
        native_id: question.id.clone(),
        summary: question.question.clone(),
        questions: vec![question],
        answer: Box::new(move |answers| {
            answers
                .and_then(|answers| user_input_response(&request, answers))
                .unwrap_or_else(|| json!({"outcome": {"outcome": "cancelled"}}))
        }),
    })
}

/// v1 `extractAntigravityElicitationForm` (:218-239): `ask_question` puts each question in its
/// field's title and only a count in the message.
fn elicitation_questions(
    request: &Value,
    questions: Vec<UserInputQuestion>,
) -> Vec<UserInputQuestion> {
    let properties = match (
        str_at(request, "mode").unwrap_or("form"),
        request
            .pointer("/requestedSchema/properties")
            .and_then(Value::as_object),
    ) {
        ("form", Some(properties)) => properties,
        _ => return questions,
    };
    questions
        .into_iter()
        .enumerate()
        .map(|(index, mut question)| {
            let Some(field) = properties.get(&question.id) else {
                return question;
            };
            let Some(title) = str_at(field, "title") else {
                return question;
            };
            let described = match field.get("description") {
                None => false,
                Some(Value::String(d)) => !d.trim().is_empty(),
                Some(_) => return question,
            };
            if described || title.trim().is_empty() {
                return question;
            }
            question.header = format!("Question {}", index + 1);
            question.question = title.trim().to_owned();
            question
        })
        .collect()
}

/// v1 `extractAntigravityElicitationForm` (:218-239) as the flavor's own form: the generic form
/// with the `ask_question` headers, answered `accept` with the typed content, or `cancel` when
/// a required answer is missing. None (not an `ask_question` form) uses the generic mapping.
pub fn elicitation_form(request: &Value) -> Option<NativeElicitationForm> {
    if str_at(request, "mode").unwrap_or("form") != "form"
        || request
            .pointer("/requestedSchema/properties")
            .and_then(Value::as_object)
            .is_none()
    {
        return None;
    }
    let schema = request.get("requestedSchema").unwrap_or(&Value::Null);
    let message = str_at(request, "message").unwrap_or_default();
    let mut form = parse_elicitation_form(schema, message, false)?;
    let questions = elicitation_questions(request, std::mem::take(&mut form.questions));
    Some(NativeElicitationForm {
        questions,
        respond: Arc::new(move |answers| match form.content(answers) {
            Some(content) => json!({"action": "accept", "content": content}),
            None => json!({"action": "cancel"}),
        }),
    })
}

struct Budget {
    nodes: i64,
    text: i64,
}

const COMMAND_LINE_FIELDS: [&str; 4] = ["CommandLine", "command_line", "commandLine", "command"];
const COMMAND_TEXT_FIELDS: [&str; 5] = [
    "aggregatedOutput",
    "combinedOutput",
    "combined_output",
    "output",
    "text",
];

/// v1 `sanitizeToolValue` (:340-394): bounded depth, node and text budget; no image bytes.
fn sanitize_value(
    value: &Value,
    budget: &mut Budget,
    depth: usize,
    field: Option<&str>,
) -> Option<Value> {
    if depth > 12 {
        return None;
    }
    let nodes = budget.nodes;
    budget.nodes -= 1;
    if nodes <= 0 {
        return None;
    }
    match value {
        Value::String(text) => {
            if text
                .get(..11)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"))
                || budget.text <= 0
            {
                return None;
            }
            let limit = TOOL_TEXT_LIMIT.min(budget.text as usize);
            let bounded = match field {
                Some(f) if COMMAND_LINE_FIELDS.contains(&f) => bound_command_line(text, limit),
                Some(f) if COMMAND_TEXT_FIELDS.contains(&f) => bound_command_text(text, limit),
                _ => bound_text(text, limit),
            };
            budget.text -= char_len(&bounded) as i64;
            Some(Value::String(bounded))
        }
        Value::Array(entries) => {
            let mut out = Vec::new();
            for entry in entries {
                if budget.nodes <= 0 {
                    break;
                }
                if let Some(sanitized) = sanitize_value(entry, budget, depth + 1, None) {
                    out.push(sanitized);
                }
            }
            Some(Value::Array(out))
        }
        Value::Object(object) => {
            let mut out = Map::new();
            let is_image = str_at(value, "type") == Some("image");
            let image_mime = str_at(value, "mimeType").is_some_and(|m| m.starts_with("image/"));
            for (key, entry) in object {
                if budget.nodes <= 0 {
                    break;
                }
                if (is_image && (key == "data" || key == "blob"))
                    || (key == "blob" && image_mime)
                    || ((key == "formatted_output" || key == "formattedOutput")
                        && (Some(entry) == object.get("combinedOutput")
                            || Some(entry) == object.get("combined_output")))
                {
                    continue;
                }
                if let Some(sanitized) = sanitize_value(entry, budget, depth + 1, Some(key)) {
                    out.insert(key.clone(), sanitized);
                }
            }
            Some(Value::Object(out))
        }
        other => Some(other.clone()),
    }
}

/// v1 `sanitizeAntigravityToolPayload` (:396-398).
pub fn sanitize_tool_payload(payload: &Value) -> Option<Value> {
    sanitize_value(
        payload,
        &mut Budget {
            nodes: 512,
            text: 64_000,
        },
        0,
        None,
    )
}

/// v1 `UNREAD_TOOL_CONTENT` (:482-483).
fn unread_tool_content() -> Value {
    json!({"type": "_t3_unknown", "originalType": "unread", "raw": null})
}

/// v1 `AcpWireSchema.ToolCallContent` decode: the entry still has what its type needs.
fn is_tool_call_content(entry: &Value) -> bool {
    match str_at(entry, "type") {
        Some("content") => {
            let Some(block) = entry.get("content") else {
                return false;
            };
            match str_at(block, "type") {
                Some("text") => block.get("text").is_some_and(Value::is_string),
                Some("image" | "audio") => {
                    block.get("data").is_some_and(Value::is_string)
                        && block.get("mimeType").is_some_and(Value::is_string)
                }
                Some("resource_link") => {
                    block.get("uri").is_some_and(Value::is_string)
                        && block.get("name").is_some_and(Value::is_string)
                }
                Some("resource") => block.get("resource").is_some_and(Value::is_object),
                _ => false,
            }
        }
        Some("diff") => {
            entry.get("path").is_some_and(Value::is_string)
                && entry.get("newText").is_some_and(Value::is_string)
        }
        Some("terminal") => entry.get("terminalId").is_some_and(Value::is_string),
        _ => false,
    }
}

/// v1 `namesSamePaths` (:485-496).
fn names_same_paths(sent: &[Value], kept: &[Value]) -> bool {
    let sent = changed_paths_of_tool_call(&json!({"content": sent}));
    let kept = changed_paths_of_tool_call(&json!({"content": kept}));
    match (sent, kept) {
        (ChangedPaths::Unknown, ChangedPaths::Unknown) => true,
        (ChangedPaths::Known(a), ChangedPaths::Known(b)) => a == b,
        _ => false,
    }
}

/// v1 `withSentRawInputPaths` (:498-508).
fn with_sent_raw_input_paths(sent: &Value, bounded: Option<Value>) -> Option<Value> {
    let (Some(sent), Some(Value::Object(mut out))) = (sent.as_object(), bounded.clone()) else {
        return bounded;
    };
    for key in ACP_RAW_INPUT_PATH_KEYS {
        let Some(path) = sent.get(key).filter(|p| !p.is_null()) else {
            continue;
        };
        if out.get(key) == Some(path) {
            continue;
        }
        let kept = match path.as_str() {
            Some(text) if char_len(text) <= TOOL_TEXT_LIMIT => text.to_owned(),
            _ => String::new(),
        };
        out.insert(key.to_owned(), Value::String(kept));
    }
    Some(Value::Object(out))
}

fn is_tool_update(update: &Value) -> bool {
    matches!(
        str_at(update, "sessionUpdate"),
        Some("tool_call" | "tool_call_update")
    )
}

/// v1 `normalizeAntigravitySessionUpdate` (:510-549): bound tool payloads; content the bounds cut
/// is marked unread so its paths count as unknown.
pub fn normalize_session_update(mut params: Value) -> Value {
    let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
        return params;
    };
    if !matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("tool_call" | "tool_call_update")
    ) {
        return params;
    }
    if let Some(Value::String(title)) = update.get("title") {
        let bounded = bound_text(title, TOOL_TEXT_LIMIT);
        update.insert("title".into(), Value::String(bounded));
    }
    if let Some(raw_input) = update.get("rawInput").cloned() {
        let bounded = with_sent_raw_input_paths(&raw_input, sanitize_tool_payload(&raw_input));
        update.insert("rawInput".into(), bounded.unwrap_or(Value::Null));
    }
    if let Some(raw_output) = update.get("rawOutput").cloned() {
        update.insert(
            "rawOutput".into(),
            sanitize_tool_payload(&raw_output).unwrap_or(Value::Null),
        );
    }
    if let Some(content) = update.get("content").cloned() {
        let mut budget = Budget {
            nodes: 512,
            text: 32_000,
        };
        let mut out = Vec::new();
        for entry in content.as_array().into_iter().flatten() {
            let kept: Vec<Value> = sanitize_value(entry, &mut budget, 0, None)
                .filter(is_tool_call_content)
                .into_iter()
                .collect();
            let same = names_same_paths(std::slice::from_ref(entry), &kept);
            out.extend(kept);
            if !same {
                out.push(unread_tool_content());
            }
        }
        update.insert("content".into(), Value::Array(out));
    }
    if let Some(meta) = update.get("_meta").cloned() {
        let sanitized = sanitize_tool_payload(&meta).filter(Value::is_object);
        update.insert("_meta".into(), sanitized.unwrap_or(Value::Null));
    }
    params
}

const CLIENT_READ_TITLES: [&str; 2] = ["Running client_view_file", "Run client_view_file?"];

/// v1 `antigravityClientReadPath` (:406-416).
fn client_read_path(update: &Value) -> Option<String> {
    if !CLIENT_READ_TITLES.contains(&str_at(update, "title")?) {
        return None;
    }
    let target = update
        .get("locations")
        .and_then(Value::as_array)
        .and_then(|l| l.first())
        .and_then(|l| str_at(l, "path"))
        .or_else(|| {
            update
                .pointer("/rawInput/absolute_path")
                .and_then(Value::as_str)
        })?;
    (!target.is_empty()).then(|| target.to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOutcome {
    Served,
    Refused,
}

#[derive(Debug, Clone)]
struct OpenRead {
    tool_call_id: String,
    path: String,
    outcome: Option<ReadOutcome>,
}

/// v1 `makeAntigravityReadRepair` (:418-480) for one session: the agent never completes a
/// subagent's `client_view_file` call and fails it with the next unrelated step error, so reads
/// GOAT served are reported completed.
#[derive(Debug, Default)]
pub struct ReadRepair {
    open: Vec<OpenRead>,
    /// The agent runs client tools in a background task, so its request can precede the call.
    early: Vec<(String, ReadOutcome)>,
}

impl ReadRepair {
    /// Earlier turns' rows are settled; their unanswered reads must not take credit.
    pub fn reset(&mut self) {
        self.open.clear();
        self.early.clear();
    }

    /// Each `fs/read_text_file` answers the oldest open read of its path. Returns the call a served
    /// read completes.
    pub fn attempted(&mut self, path: &str, served: bool) -> Option<String> {
        let outcome = if served {
            ReadOutcome::Served
        } else {
            ReadOutcome::Refused
        };
        if let Some(read) = self
            .open
            .iter_mut()
            .find(|r| r.path == path && r.outcome.is_none())
        {
            read.outcome = Some(outcome);
            return served.then(|| read.tool_call_id.clone());
        }
        self.early.push((path.to_owned(), outcome));
        None
    }

    pub fn repair(&mut self, mut params: Value) -> Value {
        let Some(update) = params.get("update").cloned() else {
            return params;
        };
        if !is_tool_update(&update) {
            return params;
        }
        let Some(id) = str_at(&update, "toolCallId").map(str::to_owned) else {
            return params;
        };
        if let Some(path) = client_read_path(&update)
            && !self.open.iter().any(|r| r.tool_call_id == id)
        {
            let outcome = self
                .early
                .iter()
                .position(|(p, _)| *p == path)
                .map(|index| self.early.remove(index).1);
            self.open.push(OpenRead {
                tool_call_id: id.clone(),
                path,
                outcome,
            });
        }
        let index = self.open.iter().position(|r| r.tool_call_id == id);
        let served = index.is_some_and(|i| self.open[i].outcome == Some(ReadOutcome::Served));
        match str_at(&update, "status") {
            Some("pending" | "in_progress") if served => {
                params["update"]["status"] = json!("completed");
            }
            Some(status @ ("completed" | "failed")) => {
                if let Some(i) = index {
                    self.open.remove(i);
                }
                if status == "failed" && served {
                    if let Some(object) = params["update"].as_object_mut() {
                        object.remove("rawOutput");
                    }
                    params["update"]["status"] = json!("completed");
                }
            }
            _ => {}
        }
        params
    }
}

/// v1 `antigravityUpdateSteps` (:738-761).
fn update_steps(raw_input: Option<&Value>) -> Option<Vec<Value>> {
    let steps = raw_input?.get("steps")?.as_array()?;
    Some(
        steps
            .iter()
            .filter_map(|step| {
                let title = str_at(step, "title")?;
                let status = match step.get("status") {
                    Some(Value::String(s)) if s == "done" => "completed".to_owned(),
                    Some(Value::String(s)) => s.clone(),
                    _ => "pending".to_owned(),
                };
                Some(json!({"content": title, "priority": "medium", "status": status}))
            })
            .collect(),
    )
}

/// v1 `makeAntigravityUpdateStepsPlans` (:763-790): agy reports its checklist only as
/// `update_steps` tool calls; each carrying steps becomes a plan update, the rest are dropped.
#[derive(Debug, Default)]
pub struct UpdateStepsPlans {
    calls: HashSet<String>,
}

impl UpdateStepsPlans {
    /// None drops the update.
    pub fn apply(&mut self, params: Value) -> Option<Value> {
        let Some(update) = params.get("update") else {
            return Some(params);
        };
        if !is_tool_update(update) {
            return Some(params);
        }
        let key = format!(
            "{}\u{0}{}",
            str_at(&params, "sessionId").unwrap_or_default(),
            str_at(update, "toolCallId").unwrap_or_default()
        );
        let kind = update.get("kind");
        if str_at(update, "title") == Some("Run update_steps")
            && (kind.is_none_or(Value::is_null) || kind.and_then(Value::as_str) == Some("other"))
        {
            self.calls.insert(key.clone());
        }
        if !self.calls.contains(&key) {
            return Some(params);
        }
        if matches!(str_at(update, "status"), Some("completed" | "failed")) {
            self.calls.remove(&key);
        }
        let entries = update_steps(update.get("rawInput"))?;
        let mut params = params;
        params["update"] = json!({"sessionUpdate": "plan", "entries": entries});
        Some(params)
    }
}

/// v1 `normalizeAntigravityToolCall` command fields (:620-688), per update: agy names the command
/// `CommandLine` (or `command_line`, `commandLine`); GOAT reads `rawInput.command`, and a call
/// with a command and no kind is a command.
pub fn normalize_tool_command(mut params: Value) -> Value {
    let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
        return params;
    };
    if !matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("tool_call" | "tool_call_update")
    ) {
        return params;
    }
    let Some(input) = update.get_mut("rawInput").and_then(Value::as_object_mut) else {
        return params;
    };
    let native = ["CommandLine", "command_line", "commandLine", "command"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| bound_command_line(c, TOOL_TEXT_LIMIT));
    let Some(command) = native else {
        return params;
    };
    if !input.get("command").is_some_and(Value::is_string) {
        input.insert("command".into(), Value::String(command));
    }
    if update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call")
        && update.get("kind").is_none_or(Value::is_null)
    {
        update.insert("kind".into(), json!("execute"));
    }
    params
}

static GOAT_MCP_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Run mcp_goat_(?<tool>[A-Za-z0-9_]+)\??$").expect("title"));
// call_mcp_tool is the one call whose rawInput names a server and tool.
static PROXIED_MCP_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$").expect("title"));

/// v1 `isAntigravityGoatMcpRequest` (AntigravityAcpSupport.ts:213-233).
pub fn is_goat_mcp_request(request: &Value) -> bool {
    let tool_call = request.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = str_at(&tool_call, "title").unwrap_or_default().trim();
    let raw_input = tool_call.get("rawInput").filter(|v| v.is_object());
    if let Some(captures) = PROXIED_MCP_TITLE.captures(title) {
        let tool = &captures["tool"];
        return raw_input.is_some_and(|input| {
            str_at(input, "ServerName") == Some("goat") && str_at(input, "ToolName") == Some(tool)
        }) && is_goat_mcp_tool(tool);
    }
    if raw_input.is_some_and(|input| input.get("CommandLine").is_some_and(Value::is_string)) {
        return false;
    }
    GOAT_MCP_TITLE
        .captures(title)
        .is_some_and(|captures| is_goat_mcp_tool(&captures["tool"]))
}

/// v1 `antigravityPermissionDisposition` (AntigravityAcpSupport.ts:235-248): GOAT's own MCP tools
/// run without asking in the automatic modes; `auto` asks for everything else.
pub fn permission_disposition(policy: &RuntimePolicy, request: &Value) -> Disposition {
    let disposition =
        policy::permission_disposition(policy, request.get("toolCall").unwrap_or(&Value::Null));
    if disposition == Disposition::Deny {
        return Disposition::Deny;
    }
    if matches!(
        policy.runtime_mode,
        RuntimeMode::Auto | RuntimeMode::AutoAcceptEdits
    ) && is_goat_mcp_request(request)
    {
        return Disposition::Allow;
    }
    if policy.runtime_mode == RuntimeMode::Auto {
        Disposition::Ask
    } else {
        disposition
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question_request() -> Value {
        json!({
            "sessionId": "s",
            "toolCall": {"toolCallId": "interaction_1", "title": "Which file?"},
            "options": [
                {"optionId": "a", "name": "Alpha", "kind": "allow_once"},
                {"optionId": "b", "name": "Beta", "kind": "allow_once"}
            ]
        })
    }

    #[test]
    fn interaction_requests_are_questions() {
        let request = question_request();
        assert!(approval_options(&request).is_empty());
        let question = user_input_question(&request).unwrap();
        assert_eq!(question.header, "Question");
        assert_eq!(question.question, "Which file?");
        assert_eq!(question.options[1].label, "Beta");
        let answers = |v: Value| v.as_object().unwrap().clone();
        assert_eq!(
            user_input_response(&request, &answers(json!({"interaction_1": "b"}))),
            Some(json!({"outcome": {"outcome": "selected", "optionId": "b"}}))
        );
        assert_eq!(
            user_input_response(&request, &answers(json!({"interaction_1": ["Alpha"]}))),
            Some(json!({"outcome": {"outcome": "selected", "optionId": "a"}}))
        );
        assert_eq!(
            user_input_response(&request, &answers(json!({"interaction_1": "zzz"}))),
            None
        );
    }

    #[test]
    fn approval_choices_carry_the_security_warning() {
        let request = json!({"toolCall": {"toolCallId": "t1"}, "options": [
            {"optionId": "once", "kind": "allow_once", "name": "Allow"},
            {"optionId": "always", "kind": "allow_always", "name": "Always", "_meta": {"agy.security.warning": {"title": "T", "message": " Runs any shell command "}}},
            {"optionId": "no", "kind": "reject_once", "name": "Deny"}
        ]});
        let options = approval_options(&request);
        assert_eq!(
            options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
            ["Allow once", "Allow for this thread", "Deny", "Cancel"]
        );
        assert_eq!(
            options[1].warning.as_deref(),
            Some("Runs any shell command")
        );
    }

    #[test]
    fn ask_question_titles_become_the_question() {
        let request = json!({"mode": "form", "message": "2 questions", "requestedSchema": {"type": "object", "properties": {
            "q1": {"type": "string", "title": "Which color?", "enum": ["red", "blue"]},
            "q2": {"type": "string", "title": "Why?", "description": "Explain"}
        }}});
        let questions = vec![
            UserInputQuestion {
                id: "q1".into(),
                header: "q1".into(),
                question: "2 questions".into(),
                options: vec![],
                multi_select: None,
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            },
            UserInputQuestion {
                id: "q2".into(),
                header: "q2".into(),
                question: "2 questions".into(),
                options: vec![],
                multi_select: None,
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            },
        ];
        let out = elicitation_questions(&request, questions);
        assert_eq!(out[0].header, "Question 1");
        assert_eq!(out[0].question, "Which color?");
        assert_eq!(out[1].header, "q2");
    }

    #[test]
    fn tool_payloads_are_bounded_and_cut_content_is_unread() {
        let long = "x".repeat(9_000);
        let long_path = format!("/w/{long}");
        let params = json!({"sessionId": "s", "update": {
            "sessionUpdate": "tool_call", "toolCallId": "t", "title": long,
            "rawInput": {"CommandLine": format!("echo {long}"), "path": "/w/a.txt"},
            "content": [
                {"type": "content", "content": {"type": "image", "data": "AAAA", "mimeType": "image/png"}},
                {"type": "diff", "path": "/w/a.txt", "oldText": "a", "newText": "b"},
                {"type": "diff", "path": long_path, "newText": "b"}
            ]
        }});
        let out = normalize_session_update(params);
        let update = &out["update"];
        assert!(
            update["title"]
                .as_str()
                .unwrap()
                .starts_with(TOOL_TEXT_TRUNCATED)
        );
        assert!(
            update["rawInput"]["CommandLine"]
                .as_str()
                .unwrap()
                .ends_with(COMMAND_LINE_TRUNCATED)
        );
        assert_eq!(update["rawInput"]["path"], "/w/a.txt");
        let content = update["content"].as_array().unwrap();
        // The image lost its bytes but named no path; the long path was cut, so it is unread.
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["path"], "/w/a.txt");
        assert_eq!(content[1]["type"], "diff");
        assert_eq!(content[2]["type"], "_t3_unknown");
        let normalized = normalize_tool_command(out);
        assert_eq!(normalized["update"]["kind"], "execute");
        assert!(
            normalized["update"]["rawInput"]["command"]
                .as_str()
                .unwrap()
                .starts_with("echo x")
        );
    }

    #[test]
    fn served_reads_complete_and_update_steps_become_plans() {
        let mut repair = ReadRepair::default();
        let call = |status: &str| json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "r1", "title": "Running client_view_file", "status": status, "rawInput": {"absolute_path": "/w/a"}, "rawOutput": "step error"}});
        assert_eq!(repair.attempted("/w/a", true), None);
        assert_eq!(
            repair.repair(call("in_progress"))["update"]["status"],
            "completed"
        );
        let failed = repair.repair(call("failed"));
        assert_eq!(failed["update"]["status"], "completed");
        assert!(failed["update"].get("rawOutput").is_none());

        let mut plans = UpdateStepsPlans::default();
        let steps = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call", "toolCallId": "u1", "title": "Run update_steps", "status": "pending", "rawInput": {"steps": [{"title": "Read", "status": "done"}, {"title": "Write"}]}}});
        let plan = plans.apply(steps).unwrap();
        assert_eq!(plan["update"]["sessionUpdate"], "plan");
        assert_eq!(plan["update"]["entries"][0]["status"], "completed");
        assert_eq!(plan["update"]["entries"][1]["status"], "pending");
        let follow = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "u1", "status": "completed"}});
        assert!(plans.apply(follow).is_none());
    }

    #[test]
    fn goat_mcp_tools_run_without_asking_in_automatic_modes() {
        let policy = |mode| RuntimePolicy {
            runtime_mode: mode,
            cwd: Some("/tmp".into()),
            extra_roots: vec![],
        };
        let goat = json!({"toolCall": {"toolCallId": "t", "title": "Run mcp_goat_goat_thread_read?", "kind": "other"}});
        let proxied = json!({"toolCall": {"toolCallId": "t", "title": "MCP Tool goat_thread_read", "rawInput": {"ServerName": "goat", "ToolName": "goat_thread_read"}}});
        let shell = json!({"toolCall": {"toolCallId": "t", "title": "Run mcp_goat_goat_thread_read?", "rawInput": {"CommandLine": "rm -rf /"}}});
        let other = json!({"toolCall": {"toolCallId": "t", "title": "Run mcp_goat_not_a_tool?"}});
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::Auto), &goat),
            Disposition::Allow
        );
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::AutoAcceptEdits), &proxied),
            Disposition::Allow
        );
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::Auto), &shell),
            Disposition::Ask
        );
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::Auto), &other),
            Disposition::Ask
        );
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::ApprovalRequired), &goat),
            Disposition::Ask
        );
        assert_eq!(
            permission_disposition(&policy(RuntimeMode::FullAccess), &other),
            Disposition::Allow
        );
    }
}

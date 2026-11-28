//! ACP session updates as GOAT turn items.
//!
//! v1: `packages/provider-acp/src/server/runtimeModel.ts` (tool call state, merge, kind to item type
//! `canonicalItemTypeFromAcpToolKind` :800-818, command extraction), `toolProjection.ts`
//! (exit codes, paths, web search), `assistantSegments.ts` (an assistant segment closes when a tool
//! starts), `unfinishedStop.ts`. GOAT 2 stores finished items only, so a tool is written once it
//! completes or fails, or when the turn ends with it open.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use goat2_contracts::{
    FileChangeDetail, ItemId, MessageId, NativeItemRef, NativeRefStrength, NoticeSeverity, PlanId,
    PlanStep, PlanStepStatus, ThreadId, TurnItem, TurnItemBody, TurnItemStatus, WebSearchResult,
};
use goat2_engine_api::EngineEvent;
use serde_json::{Map, Value, json};

use crate::flavor::{AcpFlavor, BackgroundMutation, BackgroundStatus};
use crate::wire::text_field;

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RFC 3339 UTC with milliseconds (same civil-date conversion as lane B's `items.rs`).
pub(crate) fn rfc3339_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86400);
    let time = seconds.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3600,
        time % 3600 / 60,
        time % 60,
        ms.rem_euclid(1000)
    )
}

/// v1 `ToolLifecycleItemType` from `canonicalItemTypeFromAcpToolKind` (runtimeModel.ts:800-818).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolItemType {
    DynamicTool,
    CommandExecution,
    FileChange,
    WebSearch,
}

pub fn item_type_for_kind(kind: Option<&str>) -> ToolItemType {
    match kind {
        Some("execute") => ToolItemType::CommandExecution,
        Some("edit" | "delete" | "move") => ToolItemType::FileChange,
        Some("search" | "fetch") => ToolItemType::WebSearch,
        _ => ToolItemType::DynamicTool,
    }
}

/// Merged state of one tool call (v1 `AcpToolCallState` + `mergeToolCallState`).
#[derive(Debug, Clone, Default)]
pub struct ToolState {
    pub tool_call_id: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub raw_input: Option<Value>,
    pub raw_output: Option<Value>,
    pub content: Option<Value>,
    pub locations: Option<Value>,
    pub meta: Option<Value>,
    pub name: Option<String>,
    pub started_ms: i64,
}

impl ToolState {
    /// Merge one `tool_call` / `tool_call_update` payload. ACP v2 clears a field set to null.
    pub fn merge(&mut self, update: &Value) {
        fn set_str(slot: &mut Option<String>, update: &Value, key: &str) {
            match update.get(key) {
                Some(Value::Null) => *slot = None,
                Some(Value::String(s)) if !s.trim().is_empty() => *slot = Some(s.trim().to_owned()),
                _ => {}
            }
        }
        fn set_value(slot: &mut Option<Value>, update: &Value, key: &str) {
            match update.get(key) {
                Some(Value::Null) => *slot = None,
                Some(value) => *slot = Some(value.clone()),
                None => {}
            }
        }
        set_str(&mut self.title, update, "title");
        set_str(&mut self.kind, update, "kind");
        set_str(&mut self.status, update, "status");
        set_str(&mut self.name, update, "name");
        set_value(&mut self.raw_input, update, "rawInput");
        set_value(&mut self.raw_output, update, "rawOutput");
        set_value(&mut self.content, update, "content");
        set_value(&mut self.locations, update, "locations");
        set_value(&mut self.meta, update, "_meta");
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_deref(), Some("completed" | "failed"))
    }

    /// The JSON a permission policy reads (v1 request `toolCall`).
    pub fn as_policy_value(&self) -> Value {
        let mut map = Map::new();
        if let Some(kind) = &self.kind {
            map.insert("kind".into(), json!(kind));
        }
        if let Some(v) = &self.raw_input {
            map.insert("rawInput".into(), v.clone());
        }
        if let Some(v) = &self.content {
            map.insert("content".into(), v.clone());
        }
        if let Some(v) = &self.locations {
            map.insert("locations".into(), v.clone());
        }
        Value::Object(map)
    }
}

/// v1 `extractToolCallCommand`: `rawInput.command` (string or argv) or `cmd`.
pub fn tool_command(state: &ToolState) -> Option<String> {
    let input = state.raw_input.as_ref()?;
    for key in ["command", "cmd"] {
        match input.get(key) {
            Some(Value::String(s)) if !s.trim().is_empty() => return Some(s.trim().to_owned()),
            Some(Value::Array(parts)) if !parts.is_empty() => {
                let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
            _ => {}
        }
    }
    None
}

/// v1 `commandExitCode` (toolProjection.ts:24-33).
pub fn command_exit_code(raw_output: Option<&Value>) -> Option<i32> {
    let record = raw_output?.as_object()?;
    for key in ["exitCode", "exit_code", "code"] {
        if let Some(code) = record.get(key).and_then(Value::as_i64) {
            return i32::try_from(code).ok();
        }
    }
    None
}

/// v1 `resolvedPathInfo` (toolProjection.ts:48-74).
pub fn tool_path(state: &ToolState) -> Option<String> {
    if let Some(Value::Array(locations)) = &state.locations {
        for location in locations {
            if let Some(path) = text_field(location, "path") {
                return Some(path);
            }
        }
    }
    let input = state.raw_input.as_ref()?;
    for key in ["path", "filePath", "file_path", "url", "query", "pattern"] {
        if let Some(path) = text_field(input, key) {
            return Some(path);
        }
    }
    None
}

/// Text of tool output content blocks (v1 `toolCallContentText`).
pub fn tool_output_text(state: &ToolState) -> Option<String> {
    let mut out = String::new();
    if let Some(Value::Array(content)) = &state.content {
        for entry in content {
            if entry.get("type").and_then(Value::as_str) == Some("content")
                && let Some(text) = entry
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(Value::as_str)
            {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    if out.is_empty() {
        match &state.raw_output {
            Some(Value::String(s)) => out.push_str(s),
            Some(value) => {
                for key in ["output", "stdout", "formatted_output", "aggregated_output"] {
                    if let Some(text) = value.get(key).and_then(Value::as_str) {
                        out.push_str(text);
                        break;
                    }
                }
            }
            None => {}
        }
    }
    (!out.trim().is_empty()).then_some(out)
}

fn line_counts(old: &str, new: &str) -> (u32, u32) {
    // Line multiset difference: what v1's diff summary shows as +/- for a whole-file diff.
    use std::collections::HashMap;
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for line in old.lines() {
        *counts.entry(line).or_default() -= 1;
    }
    for line in new.lines() {
        *counts.entry(line).or_default() += 1;
    }
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for value in counts.values() {
        if *value > 0 {
            additions += *value as u32;
        } else {
            deletions += (-*value) as u32;
        }
    }
    (additions, deletions)
}

/// The finished body for a tool call.
pub fn tool_body(state: &ToolState) -> TurnItemBody {
    let has_output = tool_output_text(state).is_some() || state.raw_output.is_some();
    match item_type_for_kind(state.kind.as_deref()) {
        ToolItemType::CommandExecution => TurnItemBody::CommandExecution {
            input: tool_command(state)
                .or_else(|| state.title.clone())
                .unwrap_or_else(|| "command".to_owned()),
            command_actions: None,
            output: None,
            output_omitted: has_output.then_some(true),
            output_indicates_failure: (state.status.as_deref() == Some("failed")).then_some(true),
            exit_code: if state.is_terminal() {
                command_exit_code(state.raw_output.as_ref())
            } else {
                None
            },
        },
        ToolItemType::FileChange => {
            let mut additions = 0;
            let mut deletions = 0;
            let mut changes = Vec::new();
            if let Some(Value::Array(content)) = &state.content {
                for entry in content {
                    if entry.get("type").and_then(Value::as_str) != Some("diff") {
                        continue;
                    }
                    let path = text_field(entry, "path").unwrap_or_default();
                    let old = entry.get("oldText").and_then(Value::as_str);
                    let new = entry.get("newText").and_then(Value::as_str).unwrap_or("");
                    let (a, d) = line_counts(old.unwrap_or(""), new);
                    additions += a;
                    deletions += d;
                    let operation = match (state.kind.as_deref(), old) {
                        (Some("delete"), _) => "delete",
                        (Some("move"), _) => "move",
                        (_, None) => "add",
                        _ => "modify",
                    };
                    if !path.is_empty() {
                        changes.push(FileChangeDetail {
                            operation: operation.to_owned(),
                            path,
                            old_path: None,
                            file_type: None,
                            mime_type: None,
                        });
                    }
                }
            }
            TurnItemBody::FileChange {
                file_name: tool_path(state)
                    .or_else(|| changes.first().map(|c| c.path.clone()))
                    .or_else(|| state.title.clone())
                    .unwrap_or_else(|| "file".to_owned()),
                additions: (!changes.is_empty()).then_some(additions),
                deletions: (!changes.is_empty()).then_some(deletions),
                diff_str: None,
                patch: None,
                patch_omitted: None,
                changes: (!changes.is_empty()).then_some(changes),
            }
        }
        ToolItemType::WebSearch => {
            let input = state.raw_input.clone().unwrap_or(Value::Null);
            let query = ["query", "search_query", "q", "url", "pattern"]
                .iter()
                .find_map(|key| text_field(&input, key))
                .or_else(|| state.title.clone());
            let mut results = Vec::new();
            if let Some(text) = tool_output_text(state) {
                for word in text.split_whitespace() {
                    if (word.starts_with("http://") || word.starts_with("https://"))
                        && results.len() < 20
                    {
                        let url = word.trim_end_matches(['.', ',', ';', ':', ')', ']']);
                        if !results
                            .iter()
                            .any(|r: &WebSearchResult| r.url.as_deref() == Some(url))
                        {
                            results.push(WebSearchResult {
                                title: None,
                                url: Some(url.to_owned()),
                                snippet: None,
                            });
                        }
                    }
                }
            }
            TurnItemBody::WebSearch {
                patterns: query.map(|q| vec![q]),
                results: (!results.is_empty()).then_some(results),
            }
        }
        ToolItemType::DynamicTool => TurnItemBody::DynamicTool {
            tool_name: state.name.clone().or_else(|| state.title.clone()),
            input: state.raw_input.clone().unwrap_or_else(|| json!({})),
            output: None,
            output_omitted: has_output.then_some(true),
            tool_summary: None,
        },
    }
}

fn tool_status(state: &ToolState, turn_end: Option<TurnItemStatus>) -> TurnItemStatus {
    match state.status.as_deref() {
        Some("completed") => TurnItemStatus::Completed,
        Some("failed") => TurnItemStatus::Failed,
        _ => turn_end.unwrap_or(TurnItemStatus::Running),
    }
}

#[derive(Debug)]
struct Segment {
    item_id: ItemId,
    text: String,
    started_ms: i64,
}

/// The flavor hooks the projector calls.
#[derive(Clone)]
struct Hooks(Arc<dyn AcpFlavor>);

impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0.driver())
    }
}

fn running_status(status: Option<&str>) -> bool {
    !matches!(status, Some("completed" | "failed"))
}

/// v1 `setToolOutputText` / `appendToolContentText` (toolOutputText.ts) on GOAT 2's tool state.
fn put_tool_output(tool: &mut ToolState, text: &str, append: bool) {
    let mut content = match (&tool.content, append) {
        (Some(Value::Array(list)), true) => list.clone(),
        _ => Vec::new(),
    };
    let extended = content.last_mut().is_some_and(|last| {
        if last.get("type").and_then(Value::as_str) != Some("content") {
            return false;
        }
        match last.get_mut("content") {
            Some(inner) if inner.get("type").and_then(Value::as_str) == Some("text") => {
                let previous = inner
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                inner["text"] = json!(format!("{previous}{text}"));
                true
            }
            _ => false,
        }
    });
    if !extended {
        content.push(json!({"type": "content", "content": {"type": "text", "text": text}}));
    }
    tool.content = Some(Value::Array(content));
}

/// Turns one prompt's session updates into engine events.
#[derive(Debug)]
pub struct TurnProjector {
    pub thread_id: ThreadId,
    pub driver: String,
    pub session_id: String,
    pub turn_id: String,
    ordinal: u32,
    counter: u32,
    assistant: Option<Segment>,
    reasoning: Option<Segment>,
    tools: Vec<ToolState>,
    written_tools: Vec<String>,
    plan: Option<(PlanId, Vec<PlanStep>)>,
    /// Text of every finished assistant segment (the turn's answer, for diagnostics and tests).
    pub answer: String,
    hooks: Option<Hooks>,
    launch_env: Vec<(String, String)>,
    /// v1 `toolCallIdsByBackgroundTaskId`.
    background_tasks: Vec<(String, String)>,
    /// v1 `persistentBackgroundTaskIds`.
    persistent_tasks: HashSet<String>,
    /// v1 `endedBackgroundTaskIds`: tasks a structured end closed.
    ended_tasks: HashSet<String>,
    /// v1 `awaitingBackgroundHydration`.
    awaiting_hydration: HashSet<String>,
    /// v1 `lastCapturedProposedPlan` for this turn: (item id, plan id, ordinal, markdown).
    proposed: Option<(ItemId, PlanId, u32, String)>,
}

impl TurnProjector {
    pub fn new(
        thread_id: ThreadId,
        driver: impl Into<String>,
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        first_ordinal: u32,
    ) -> Self {
        Self {
            thread_id,
            driver: driver.into(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            ordinal: first_ordinal,
            counter: 0,
            assistant: None,
            reasoning: None,
            tools: Vec::new(),
            written_tools: Vec::new(),
            plan: None,
            answer: String::new(),
            hooks: None,
            launch_env: Vec::new(),
            background_tasks: Vec::new(),
            persistent_tasks: HashSet::new(),
            ended_tasks: HashSet::new(),
            awaiting_hydration: HashSet::new(),
            proposed: None,
        }
    }

    /// Let the flavor normalize tool calls and report background tasks and plan files.
    /// `launch_env` is the session's launch environment (plan file paths read it).
    pub fn with_flavor(
        mut self,
        flavor: Arc<dyn AcpFlavor>,
        launch_env: Vec<(String, String)>,
    ) -> Self {
        self.hooks = Some(Hooks(flavor));
        self.launch_env = launch_env;
        self
    }

    pub fn next_ordinal(&self) -> u32 {
        self.ordinal
    }

    /// Reserve the next ordinal for an item the driver builds itself (subagents).
    pub fn take_ordinal(&mut self) -> u32 {
        let ordinal = self.ordinal;
        self.ordinal += 1;
        ordinal
    }

    fn new_item_id(&mut self, kind: &str) -> ItemId {
        self.counter += 1;
        ItemId::new(format!("{}:{kind}:{}", self.turn_id, self.counter))
    }

    fn item(
        &mut self,
        id: ItemId,
        native_id: Option<String>,
        status: TurnItemStatus,
        title: Option<String>,
        started_ms: Option<i64>,
        body: TurnItemBody,
    ) -> TurnItem {
        let now = now_ms();
        let ordinal = self.ordinal;
        self.ordinal += 1;
        TurnItem {
            id,
            thread_id: self.thread_id.clone(),
            run_id: None,
            provider_thread_id: Some(self.session_id.clone()),
            provider_turn_id: Some(self.turn_id.clone()),
            native_item_ref: Some(NativeItemRef {
                driver: self.driver.clone(),
                native_id,
                strength: NativeRefStrength::Weak,
                fingerprint: None,
                ordinal: None,
            }),
            parent_item_id: None,
            ordinal,
            status,
            title,
            started_at: started_ms.map(rfc3339_ms),
            completed_at: Some(rfc3339_ms(now)),
            updated_at: rfc3339_ms(now),
            body,
        }
    }

    fn completed(&self, item: TurnItem) -> EngineEvent {
        EngineEvent::ItemCompleted {
            turn_id: self.turn_id.clone(),
            item: Box::new(item),
            locator: None,
        }
    }

    fn close_assistant(&mut self, out: &mut Vec<EngineEvent>) {
        if let Some(segment) = self.assistant.take() {
            if segment.text.trim().is_empty() {
                return;
            }
            if !self.answer.is_empty() {
                self.answer.push('\n');
            }
            self.answer.push_str(&segment.text);
            let message_id = MessageId::new(segment.item_id.as_str());
            let item = self.item(
                segment.item_id,
                None,
                TurnItemStatus::Completed,
                None,
                Some(segment.started_ms),
                TurnItemBody::AssistantMessage {
                    phase: None,
                    delivery: None,
                    message_id,
                    text: segment.text,
                    attachments: None,
                    streaming: false,
                },
            );
            out.push(self.completed(item));
        }
    }

    fn close_reasoning(&mut self, out: &mut Vec<EngineEvent>) {
        if let Some(segment) = self.reasoning.take() {
            if segment.text.trim().is_empty() {
                return;
            }
            let item = self.item(
                segment.item_id,
                None,
                TurnItemStatus::Completed,
                None,
                Some(segment.started_ms),
                TurnItemBody::Reasoning {
                    text: segment.text,
                    streaming: false,
                },
            );
            out.push(self.completed(item));
        }
    }

    /// Close streaming segments (a tool, request or notice comes next).
    pub fn close_segments(&mut self, out: &mut Vec<EngineEvent>) {
        self.close_reasoning(out);
        self.close_assistant(out);
    }

    pub fn tool(&self, tool_call_id: &str) -> Option<&ToolState> {
        self.tools.iter().find(|t| t.tool_call_id == tool_call_id)
    }

    pub fn tool_item_id(&self, tool_call_id: &str) -> ItemId {
        ItemId::new(format!("{}:tool:{tool_call_id}", self.turn_id))
    }

    fn write_tool(
        &mut self,
        index: usize,
        turn_end: Option<TurnItemStatus>,
        out: &mut Vec<EngineEvent>,
    ) {
        let state = self.tools[index].clone();
        if self.written_tools.contains(&state.tool_call_id) {
            return;
        }
        self.written_tools.push(state.tool_call_id.clone());
        let id = self.tool_item_id(&state.tool_call_id);
        let status = tool_status(&state, turn_end);
        let title = state.title.clone();
        let item = self.item(
            id,
            Some(state.tool_call_id.clone()),
            status,
            title,
            Some(state.started_ms),
            tool_body(&state),
        );
        out.push(self.completed(item));
    }

    /// Track a tool call seen outside `session/update` (a permission request's `toolCall`).
    pub fn observe_tool_call(&mut self, tool_call: &Value) -> Option<ToolState> {
        let id = text_field(tool_call, "toolCallId")?;
        let index = match self.tools.iter().position(|t| t.tool_call_id == id) {
            Some(index) => index,
            None => {
                self.tools.push(ToolState {
                    tool_call_id: id,
                    started_ms: now_ms(),
                    ..ToolState::default()
                });
                self.tools.len() - 1
            }
        };
        self.tools[index].merge(tool_call);
        // v1 emitTool (adapter.ts:2485-2487) keeps the normalized state.
        if let Some(hooks) = &self.hooks {
            let merged = std::mem::take(&mut self.tools[index]);
            self.tools[index] = hooks.0.normalize_tool_call(merged);
        }
        Some(self.tools[index].clone())
    }

    /// Apply one normalized `update` object.
    pub fn apply(&mut self, update: &Value, out: &mut Vec<EngineEvent>) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "agent_message_chunk" | "agent_message" => {
                let Some(text) = content_text(update.get("content")) else {
                    return;
                };
                self.close_reasoning(out);
                if self.assistant.is_none() {
                    let item_id = self.new_item_id("assistant");
                    self.assistant = Some(Segment {
                        item_id,
                        text: String::new(),
                        started_ms: now_ms(),
                    });
                }
                let segment = self.assistant.as_mut().expect("segment");
                segment.text.push_str(&text);
                out.push(EngineEvent::TextDelta {
                    turn_id: self.turn_id.clone(),
                    item_id: segment.item_id.clone(),
                    text,
                });
            }
            "agent_thought_chunk" | "agent_thought" => {
                let Some(text) = content_text(update.get("content")) else {
                    return;
                };
                self.close_assistant(out);
                if self.reasoning.is_none() {
                    let item_id = self.new_item_id("reasoning");
                    self.reasoning = Some(Segment {
                        item_id,
                        text: String::new(),
                        started_ms: now_ms(),
                    });
                }
                let segment = self.reasoning.as_mut().expect("segment");
                segment.text.push_str(&text);
                out.push(EngineEvent::TextDelta {
                    turn_id: self.turn_id.clone(),
                    item_id: segment.item_id.clone(),
                    text,
                });
            }
            "tool_call" | "tool_call_update" => {
                self.close_segments(out);
                if self.observe_tool_call(update).is_none() {
                    return;
                }
                let id = text_field(update, "toolCallId").unwrap_or_default();
                self.after_tool_update(&id, out);
            }
            // v1 adapter.ts:4047-4087: background output Grok injects as user text (subagent end
            // notices in the same text are the tracker's).
            "user_message_chunk" => {
                let content = update.get("content");
                if content.and_then(|c| c.get("type")).and_then(Value::as_str) != Some("text") {
                    return;
                }
                if let Some(text) = content.and_then(|c| c.get("text")).and_then(Value::as_str) {
                    self.injected_user_text(text);
                }
            }
            "plan" => {
                let steps = plan_steps(update);
                let plan_id = self
                    .plan
                    .as_ref()
                    .map(|(id, _)| id.clone())
                    .unwrap_or_else(|| PlanId::new(format!("{}:plan", self.turn_id)));
                self.plan = Some((plan_id, steps));
            }
            // v1 acpNoticeContent (noticeProjection.ts:14-24): title, then the description after a
            // blank line; severities other than info keep the warning treatment.
            "notice" => {
                let Some(title) = text_field(update, "title") else {
                    return;
                };
                self.close_segments(out);
                let message = match text_field(update, "description") {
                    Some(description) => format!("{title}\n\n{description}"),
                    None => title,
                };
                let severity = match update.get("severity").and_then(Value::as_str) {
                    Some("info") => Some(NoticeSeverity::Info),
                    _ => Some(NoticeSeverity::Warning),
                };
                let id = self.new_item_id("notice");
                let item = self.item(
                    id,
                    None,
                    TurnItemStatus::Completed,
                    None,
                    None,
                    TurnItemBody::SystemNotice { message, severity },
                );
                out.push(self.completed(item));
            }
            _ => {}
        }
    }

    /// Emit a system notice (unfinished stop reasons, auth hints).
    pub fn notice(&mut self, message: String, warning: bool, out: &mut Vec<EngineEvent>) {
        self.close_segments(out);
        let id = self.new_item_id("notice");
        let item = self.item(
            id,
            None,
            TurnItemStatus::Completed,
            None,
            None,
            TurnItemBody::SystemNotice {
                message,
                severity: Some(if warning {
                    NoticeSeverity::Warning
                } else {
                    NoticeSeverity::Info
                }),
            },
        );
        out.push(self.completed(item));
    }

    /// Record a proposed plan (v1 `captureProposedPlan`).
    pub fn proposed_plan(&mut self, markdown: String, out: &mut Vec<EngineEvent>) {
        // v1 adapter.ts:1157-1192: trimmed, empty skipped, the same plan twice in a turn skipped; a
        // changed plan updates the turn's one proposed-plan item.
        let markdown = markdown.trim().to_owned();
        if markdown.is_empty() {
            return;
        }
        if self
            .proposed
            .as_ref()
            .is_some_and(|(_, _, _, last)| *last == markdown)
        {
            return;
        }
        self.close_segments(out);
        let (id, plan_id, ordinal) = match self.proposed.take() {
            Some((id, plan_id, ordinal, _)) => (id, plan_id, ordinal),
            None => {
                let id = ItemId::new(format!("{}:proposed-plan", self.turn_id));
                let ordinal = self.ordinal;
                self.ordinal += 1;
                (id.clone(), PlanId::new(id.as_str()), ordinal)
            }
        };
        self.proposed = Some((id.clone(), plan_id.clone(), ordinal, markdown.clone()));
        let mut item = self.item(
            id,
            None,
            TurnItemStatus::Completed,
            None,
            None,
            TurnItemBody::ProposedPlan {
                plan_id,
                markdown,
                streaming: false,
            },
        );
        // `item` took the next ordinal; the plan keeps the one it was first given.
        self.ordinal -= 1;
        item.ordinal = ordinal;
        out.push(self.completed(item));
    }

    /// v1 `lastProposedPlanMarkdown` (adapter.ts:1252-1258): the plan captured in this turn.
    pub fn last_proposed_plan(&self) -> Option<String> {
        self.proposed
            .as_ref()
            .map(|(_, _, _, markdown)| markdown.clone())
    }

    /// v1 `hydratedRegisteredMonitor` (adapter.ts:2558-2621): the tool call reports on a background
    /// task this turn registered. Such a poll resembles subagent hydration and is not one.
    pub fn reports_on_registered_background_task(
        &self,
        flavor: &dyn AcpFlavor,
        tool: &ToolState,
    ) -> bool {
        let own = flavor.background_task_id(tool);
        flavor.background_task_completions(tool).iter().any(|c| {
            own.as_deref() == Some(c.task_id.as_str())
                || self
                    .background_tasks
                    .iter()
                    .any(|(task, _)| *task == c.task_id)
        })
    }

    fn background_tool_index(&self, task_id: &str) -> Option<usize> {
        let tool_id = self
            .background_tasks
            .iter()
            .find(|(task, _)| task == task_id)
            .map(|(_, tool)| tool.clone())?;
        self.tools.iter().position(|t| t.tool_call_id == tool_id)
    }

    /// After a tool call merged: plan files, background tasks, then the tool itself (v1 `emitTool`,
    /// adapter.ts:2474-2642, with the plan capture of adapter.ts:3257-3264). Subagent tool calls
    /// never reach the projector: [crate::subagents::SubagentTracker] takes them first.
    fn after_tool_update(&mut self, tool_call_id: &str, out: &mut Vec<EngineEvent>) {
        let Some(index) = self
            .tools
            .iter()
            .position(|t| t.tool_call_id == tool_call_id)
        else {
            return;
        };
        let tool = self.tools[index].clone();
        let Some(hooks) = self.hooks.clone() else {
            if tool.is_terminal() {
                self.write_tool(index, None, out);
            }
            return;
        };
        let flavor = &hooks.0;
        if let Some(markdown) = flavor.proposed_plan_markdown(&tool, &self.launch_env)
            && !markdown.is_empty()
        {
            self.proposed_plan(markdown, out);
        }
        if let Some(task_id) = flavor.background_task_id(&tool) {
            if !self
                .background_tasks
                .iter()
                .any(|(task, _)| *task == task_id)
            {
                self.background_tasks
                    .push((task_id.clone(), tool.tool_call_id.clone()));
            }
            if flavor.is_persistent_background_tool(&tool) {
                self.persistent_tasks.insert(task_id);
            }
        }
        for completion in flavor.background_task_completions(&tool) {
            if completion.status != BackgroundStatus::Running {
                self.awaiting_hydration.remove(&completion.task_id);
            }
            if let Some(target) = self.background_tool_index(&completion.task_id)
                && self.tools[target].tool_call_id != tool.tool_call_id
            {
                self.hydrate_background_tool(target, &completion, out);
            }
        }
        if tool.is_terminal() {
            self.write_tool(index, None, out);
        }
    }

    /// v1 adapter.ts:2581-2615: a poll or kill reports on a registered background tool.
    fn hydrate_background_tool(
        &mut self,
        index: usize,
        completion: &BackgroundMutation,
        out: &mut Vec<EngineEvent>,
    ) {
        let tool = &mut self.tools[index];
        tool.status = Some(
            match completion.status {
                BackgroundStatus::Running => "in_progress",
                BackgroundStatus::Failed => "failed",
                BackgroundStatus::Completed => "completed",
            }
            .into(),
        );
        if !completion.append_output.is_empty() {
            let empty = tool_output_text(tool).is_none();
            put_tool_output(tool, &completion.append_output, !empty);
        }
        if completion.status != BackgroundStatus::Running {
            self.ended_tasks.insert(completion.task_id.clone());
            self.write_tool(index, None, out);
        }
    }

    /// v1 adapter.ts:4047-4111.
    fn injected_user_text(&mut self, text: &str) {
        let Some(hooks) = self.hooks.clone() else {
            return;
        };
        for mutation in hooks.0.background_tool_mutations(text) {
            let Some(index) = self.background_tool_index(&mutation.task_id) else {
                continue;
            };
            // An ended monitor stays open until its output is hydrated or the task ends.
            if mutation.status != BackgroundStatus::Running {
                self.awaiting_hydration.insert(mutation.task_id.clone());
            }
            let tool = &mut self.tools[index];
            tool.status = Some("in_progress".into());
            put_tool_output(tool, &mutation.append_output, true);
        }
    }

    /// A structured background task start or end (v1 `applyBackgroundTaskMutation` and
    /// `finishRegisteredBackgroundTool`, adapter.ts:3187-3213,5480-5530).
    pub fn background_task(
        &mut self,
        task_id: &str,
        status: BackgroundStatus,
        output: Option<&str>,
        out: &mut Vec<EngineEvent>,
    ) {
        if status == BackgroundStatus::Running {
            self.ended_tasks.remove(task_id);
            return;
        }
        self.ended_tasks.insert(task_id.to_owned());
        self.awaiting_hydration.remove(task_id);
        let Some(index) = self.background_tool_index(task_id) else {
            return;
        };
        if !running_status(self.tools[index].status.as_deref()) {
            return;
        }
        let tool = &mut self.tools[index];
        tool.status = Some(
            if status == BackgroundStatus::Failed {
                "failed"
            } else {
                "completed"
            }
            .into(),
        );
        if let Some(output) = output {
            put_tool_output(tool, output, false);
        }
        self.write_tool(index, None, out);
    }

    /// v1 `hasAcpDeferredBackgroundWork` (deferredBackground.ts:13-43) for flavors without
    /// `toolOutlivesPrompt` / `wakeOnDetachedRequest`: hydration still owed or a non-persistent
    /// background task still running. Running subagents are the tracker's
    /// ([crate::subagents::SubagentTracker::blocks_turn]); the driver asks both.
    pub fn has_deferred_background_work(&self) -> bool {
        if !self.awaiting_hydration.is_empty() {
            return true;
        }
        for (task_id, tool_id) in &self.background_tasks {
            if self.persistent_tasks.contains(task_id) || self.ended_tasks.contains(task_id) {
                continue;
            }
            if self
                .tool(tool_id)
                .is_some_and(|tool| running_status(tool.status.as_deref()))
            {
                return true;
            }
        }
        false
    }

    /// Close everything at the end of the prompt. Open tools take `open_tool_status`.
    pub fn finish(&mut self, open_tool_status: TurnItemStatus, out: &mut Vec<EngineEvent>) {
        self.close_segments(out);
        for index in 0..self.tools.len() {
            self.write_tool(index, Some(open_tool_status), out);
        }
        if let Some((plan_id, steps)) = self.plan.take()
            && !steps.is_empty()
        {
            let id = ItemId::new(plan_id.as_str());
            let item = self.item(
                id,
                None,
                TurnItemStatus::Completed,
                None,
                None,
                TurnItemBody::TodoList {
                    plan_id,
                    steps,
                    explanation: None,
                },
            );
            out.push(self.completed(item));
        }
    }
}

/// Text of an ACP content block (v1 `acpContentBlockDisplayText` for text blocks).
pub fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    match content.get("type").and_then(Value::as_str) {
        Some("text") | None => content
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        Some("resource_link") => text_field(content, "uri"),
        _ => None,
    }
}

fn plan_steps(update: &Value) -> Vec<PlanStep> {
    update
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| {
                    let text = text_field(entry, "content")?;
                    let status = match entry.get("status").and_then(Value::as_str) {
                        Some("in_progress") => PlanStepStatus::Running,
                        Some("completed") => PlanStepStatus::Completed,
                        _ => PlanStepStatus::Pending,
                    };
                    Some(PlanStep {
                        id: format!("step-{}", index + 1),
                        text,
                        status,
                        duration_anchor_at: None,
                        duration_ms: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// v1 `acpUnfinishedStopMessage` (unfinishedStop.ts:4-17).
pub fn unfinished_stop_message(stop_reason: &str) -> Option<&'static str> {
    match stop_reason {
        "refusal" => Some(
            "The agent refused this request. The agent's next turn won't include this message or its reply.",
        ),
        "max_tokens" => Some("The agent stopped because its reply reached the output token limit."),
        "max_turn_requests" => {
            Some("The agent stopped because it reached its request limit for this turn.")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projector() -> TurnProjector {
        TurnProjector::new(ThreadId::new("t1"), "acpRegistry", "s1", "turn-1", 0)
    }

    #[test]
    fn assistant_text_streams_and_closes_at_tool() {
        let mut p = projector();
        let mut out = Vec::new();
        p.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hel"}}), &mut out);
        p.apply(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "lo"}}), &mut out);
        p.apply(&json!({"sessionUpdate": "tool_call", "toolCallId": "c1", "title": "ls", "kind": "execute", "status": "pending", "rawInput": {"command": ["ls", "-la"]}}), &mut out);
        p.apply(&json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed", "rawOutput": {"exitCode": 0, "stdout": "a"}}), &mut out);
        p.finish(TurnItemStatus::Interrupted, &mut out);
        let completed: Vec<&TurnItem> = out
            .iter()
            .filter_map(|e| match e {
                EngineEvent::ItemCompleted { item, .. } => Some(item.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(completed.len(), 2);
        assert!(
            matches!(&completed[0].body, TurnItemBody::AssistantMessage { text, .. } if text == "Hello")
        );
        match &completed[1].body {
            TurnItemBody::CommandExecution {
                input,
                exit_code,
                output_omitted,
                ..
            } => {
                assert_eq!(input, "ls -la");
                assert_eq!(*exit_code, Some(0));
                assert_eq!(*output_omitted, Some(true));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(p.answer, "Hello");
    }

    #[test]
    fn open_tools_take_turn_end_status_and_plan_is_written() {
        let mut p = projector();
        let mut out = Vec::new();
        p.apply(&json!({"sessionUpdate": "tool_call", "toolCallId": "e1", "title": "Edit a.rs", "kind": "edit", "content": [{"type": "diff", "path": "/w/a.rs", "oldText": "a\nb", "newText": "a\nc\nd"}]}), &mut out);
        p.apply(&json!({"sessionUpdate": "plan", "entries": [{"content": "Do it", "status": "in_progress", "priority": "high"}]}), &mut out);
        p.finish(TurnItemStatus::Interrupted, &mut out);
        let items: Vec<&TurnItem> = out
            .iter()
            .filter_map(|e| match e {
                EngineEvent::ItemCompleted { item, .. } => Some(item.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(items[0].status, TurnItemStatus::Interrupted);
        match &items[0].body {
            TurnItemBody::FileChange {
                file_name,
                additions,
                deletions,
                ..
            } => {
                assert_eq!(file_name, "/w/a.rs");
                assert_eq!((*additions, *deletions), (Some(2), Some(1)));
            }
            other => panic!("{other:?}"),
        }
        assert!(
            matches!(&items[1].body, TurnItemBody::TodoList { steps, .. } if steps[0].status == PlanStepStatus::Running)
        );
    }

    #[test]
    fn rfc3339() {
        assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
    }
}

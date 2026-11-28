//! xAI tool calls: subagents, background tasks, monitors, titles and status fixes.
//!
//! Ported from v1 (goat-si/goat 916b5ccc1b2):
//! - `packages/provider-grok/src/server/xaiAcpExtension.ts:98-859` (subagent and background task
//!   extraction, `normalizeXAiAcpToolCallState`, monitor event parsing, subagent end notices),
//! - `packages/provider-grok/src/server/xaiMcpToolCall.ts:13-57` (`use_tool` MCP calls),
//! - `packages/provider-grok/src/server/commandTitle.ts:1-7` (`truncateCommandTitle`).
//!
//! v1 reads `AcpToolCallState` (`toolCallId`, `title`, `status`, `data.rawInput`,
//! `data.rawOutput`, `data.content`, `data.meta`); GOAT 2 reads the same fields from
//! [ToolState]. v1 spells the running status `inProgress`; GOAT 2 keeps ACP's `in_progress`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use goat2_contracts::TurnItemStatus;

use crate::flavor::{BackgroundMutation, BackgroundStatus, SubagentEndNotice, SubagentUpdate};
use crate::items::ToolState;

/// v1 `XAI_UUID_RE` (xaiAcpExtension.ts:121), used case-insensitively.
const UUID: &str = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid xAI pattern")
}

macro_rules! lazy_re {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| re(&$pattern));
    };
}

lazy_re!(UUID_ONLY, format!("(?i)^{UUID}$"));
lazy_re!(
    AGENT_ID,
    format!(r"(?i)(?:^|\n)\s*Agent ID:\s*({UUID})(?-u:\b)")
);
lazy_re!(
    SUBAGENT_ID,
    format!(r"(?i)(?:^|\n)\s*subagent_id:\s*({UUID})(?-u:\b)")
);
lazy_re!(TASK_HEADER, format!(r"(?i)===\s*Task\s+({UUID})\s*==="));
lazy_re!(SPAWN_IN_BACKGROUND, r"(?i)subagent started in background");
lazy_re!(SUBAGENT_ID_ANY, format!(r"(?i)subagent_id:\s*{UUID}"));
lazy_re!(GET_OUTPUT_TOOL_NAME, r"(?i)get_command_or_subagent_output");
lazy_re!(MONITOR_ACK, r"(?i)monitor started\s*\(\s*task\s+");
lazy_re!(
    MONITOR_ACK_ID,
    format!(r"(?i)monitor started\s*\(\s*task\s+({UUID})(?-u:\b)")
);
lazy_re!(
    MONITOR_EVENT,
    format!(
        r#"(?i)<monitor-event\s+task_id=["']?({UUID})["']?\s*>\s*([\s\S]*?)\s*</monitor-event>"#
    )
);
lazy_re!(
    MONITOR_BATCH,
    format!(r#"(?i)<monitor\s[^>]*task_id=["']?({UUID})["']?[^>]*>\s*([\s\S]*?)\s*</monitor>"#)
);
lazy_re!(
    MONITOR_ENDED,
    format!(r#"(?i)Monitor\s+["']?({UUID})["']?\s+ended"#)
);
lazy_re!(EXITED_CODE_ZERO, r"(?i)exited\s*\(\s*code\s*0\s*\)");
lazy_re!(ENDED_CLEANLY, r"(?i)ended cleanly");
lazy_re!(FAILURE_WORDS, r"(?i)exited|failed|error|signal");
lazy_re!(SYSTEM_REMINDER, r"(?i)</?system-reminder>");
lazy_re!(
    BACKGROUND_SUBAGENT,
    format!(r#"(?i)Background subagent\s+["']?({UUID})["']?"#)
);
lazy_re!(COMPLETED_SUCCESSFULLY, r"(?i)completed successfully");
lazy_re!(
    END_FAILURE,
    r"(?i)(?-u:\b)(failed|errored|error|crashed|cancelled|canceled|interrupted|timed out)(?-u:\b)"
);
lazy_re!(
    END_COMPLETED,
    r"(?i)(?-u:\b)(completed|finished|ended)(?-u:\b)"
);
lazy_re!(
    SUBAGENT_META,
    r"(?i)<subagent_meta>[\s\S]*?</subagent_meta>"
);
lazy_re!(
    SUBAGENT_RESULT,
    r"(?i)<subagent_result>[\s\S]*?</subagent_result>"
);
lazy_re!(OUTPUT_MARKER, r"(?i)=== Output ===\s*([\s\S]*)$");
lazy_re!(STATUS_FAILED, r"(?i)Status:\s*failed");
lazy_re!(EXIT_CODE_DIGIT, r"(?i)Exit Code:\s*-?([0-9])");
lazy_re!(STATUS_COMPLETED, r"(?i)Status:\s*completed");
lazy_re!(STATUS_SUCCESS, r"(?i)Status:\s*success");
lazy_re!(STATUS_RUNNING, r"(?i)Status:\s*running");
lazy_re!(STATUS_PENDING, r"(?i)Status:\s*pending");
lazy_re!(
    AGENT_ID_LINE,
    format!(r"(?i)(?:^|\n)\s*Agent ID:\s*{UUID}[^\n]*(?:\n|$)")
);
lazy_re!(
    SUBAGENT_ID_LINE,
    format!(r"(?i)(?:^|\n)\s*subagent_id:\s*{UUID}[^\n]*(?:\n|$)")
);

/// v1 `unknownRecord`.
fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// v1 `nonEmptyString`: trimmed, non-empty.
pub(crate) fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn lower(value: Option<String>) -> Option<String> {
    value.map(|s| s.to_lowercase())
}

/// v1 `titleKey`.
fn title_key(tool: &ToolState) -> String {
    tool.title.as_deref().unwrap_or("").trim().to_lowercase()
}

fn is_uuid(value: &str) -> bool {
    UUID_ONLY.is_match(value)
}

/// `Uint8Array.from(numbers)` then `TextDecoder.decode` (invalid UTF-8 becomes U+FFFD).
fn decode_bytes(entries: &[Value]) -> Option<String> {
    let mut bytes = Vec::with_capacity(entries.len());
    for entry in entries {
        let number = entry.as_f64()?;
        let byte = if number.is_finite() {
            (number.trunc() as i64).rem_euclid(256) as u8
        } else {
            0
        };
        bytes.push(byte);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// v1 `decodeByteText` (xaiAcpExtension.ts:136-146).
fn decode_byte_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(_) => non_empty(value),
        Value::Array(entries) if !entries.is_empty() => {
            let text = decode_bytes(entries)?;
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        _ => None,
    }
}

/// v1 `xAiToolOutputText` (xaiAcpExtension.ts:148-179).
pub fn tool_output_text(tool: &ToolState) -> Option<String> {
    if let Some(raw) = record(tool.raw_output.as_ref()) {
        let direct = non_empty(raw.get("text"))
            .or_else(|| non_empty(raw.get("output_for_prompt")))
            .or_else(|| decode_byte_text(raw.get("output")));
        if direct.is_some() {
            return direct;
        }
        if let Some(result) = record(raw.get("Result")).or_else(|| record(raw.get("result"))) {
            let nested = non_empty(result.get("output"))
                .or_else(|| non_empty(result.get("text")))
                .or_else(|| decode_byte_text(result.get("output")));
            if nested.is_some() {
                return nested;
            }
        }
    }
    if let Some(Value::String(_)) = &tool.raw_output {
        return non_empty(tool.raw_output.as_ref());
    }
    let Some(Value::Array(content)) = &tool.content else {
        return None;
    };
    let text = content
        .iter()
        .filter_map(|entry| {
            let entry_record = entry.as_object();
            let nested = entry_record
                .and_then(|r| r.get("content"))
                .and_then(Value::as_object);
            non_empty(nested.and_then(|n| n.get("text")))
                .or_else(|| non_empty(entry_record.and_then(|r| r.get("text"))))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn first_capture(text: &str, pattern: &Regex) -> Option<String> {
    pattern
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

/// v1 `extractXAiChildSessionId` (xaiAcpExtension.ts:186-194).
fn child_session_id(output: Option<&str>) -> Option<String> {
    let output = output?;
    first_capture(output, &AGENT_ID)
        .or_else(|| first_capture(output, &SUBAGENT_ID))
        .or_else(|| first_capture(output, &TASK_HEADER))
}

/// v1 `isXAiAsyncSpawnAck` (xaiAcpExtension.ts:196-203).
fn is_async_spawn_ack(output: Option<&str>) -> bool {
    let Some(output) = output else {
        return false;
    };
    SPAWN_IN_BACKGROUND.is_match(output)
        || (SUBAGENT_ID_ANY.is_match(output) && GET_OUTPUT_TOOL_NAME.is_match(output))
}

/// v1 `isXAiMonitorStartAck` (xaiAcpExtension.ts:205-208).
fn is_monitor_start_ack(output: Option<&str>) -> bool {
    output.is_some_and(|o| MONITOR_ACK.is_match(o))
}

fn raw_input(tool: &ToolState) -> Option<&Map<String, Value>> {
    record(tool.raw_input.as_ref())
}

fn raw_output(tool: &ToolState) -> Option<&Map<String, Value>> {
    record(tool.raw_output.as_ref())
}

fn variant(input: Option<&Map<String, Value>>) -> Option<String> {
    lower(non_empty(input.and_then(|i| i.get("variant"))))
}

fn output_type(tool: &ToolState) -> Option<String> {
    lower(non_empty(raw_output(tool).and_then(|o| o.get("type"))))
}

/// v1 `isXAiSpawnOrTaskTool` (xaiAcpExtension.ts:210-225).
fn is_spawn_or_task_tool(tool: &ToolState, input: Option<&Map<String, Value>>) -> bool {
    let title = title_key(tool);
    if title == "task" || title == "spawn_subagent" || title.contains("spawn subagent") {
        return true;
    }
    if matches!(
        variant(input).as_deref(),
        Some("cursortask" | "task" | "spawn_subagent")
    ) {
        return true;
    }
    non_empty(input.and_then(|i| i.get("subagent_type"))).is_some()
        || non_empty(input.and_then(|i| i.get("subagentType"))).is_some()
}

/// v1 `isXAiGetSubagentOutputTool` (xaiAcpExtension.ts:227-246).
fn is_get_subagent_output_tool(tool: &ToolState, input: Option<&Map<String, Value>>) -> bool {
    let title = title_key(tool);
    if title == "get_command_or_subagent_output"
        || title.contains("get_command_or_subagent_output")
        || title == "wait_commands_or_subagents"
    {
        return true;
    }
    if matches!(
        variant(input).as_deref(),
        Some("taskoutput" | "task_output")
    ) {
        return true;
    }
    if matches!(
        output_type(tool).as_deref(),
        Some("taskoutput" | "task_output")
    ) {
        return true;
    }
    title.starts_with("[subagent:")
        && input
            .and_then(|i| i.get("task_ids"))
            .is_some_and(Value::is_array)
}

/// v1 `isXAiMonitorTool` (xaiAcpExtension.ts:248-260).
pub fn is_monitor_tool(tool: &ToolState) -> bool {
    let title = title_key(tool);
    if title == "monitor" || title.starts_with("monitor ") {
        return true;
    }
    if variant(raw_input(tool)).as_deref() == Some("monitor") {
        return true;
    }
    if output_type(tool).as_deref() == Some("monitor") {
        return true;
    }
    is_monitor_start_ack(tool_output_text(tool).as_deref())
}

/// v1 `xAiBackgroundShellTaskId` (xaiAcpExtension.ts:262-271): `BackgroundTaskStarted` completes
/// the tool call while the shell process still runs.
pub fn background_shell_task_id(tool: &ToolState) -> Option<String> {
    let output = raw_output(tool)?;
    (non_empty(output.get("type")).as_deref() == Some("BackgroundTaskStarted"))
        .then(|| non_empty(output.get("task_id")))
        .flatten()
}

/// v1 `extractXAiMonitorTaskId` (xaiAcpExtension.ts:273-296).
pub fn monitor_task_id(tool: &ToolState) -> Option<String> {
    if let Some(id) = background_shell_task_id(tool) {
        return Some(id);
    }
    if !is_monitor_tool(tool) {
        return None;
    }
    if let Some(output) = raw_output(tool)
        && output_type(tool).as_deref() == Some("monitor")
        && let Some(id) =
            non_empty(output.get("taskId")).or_else(|| non_empty(output.get("task_id")))
    {
        return Some(id);
    }
    if let Some(output) = tool_output_text(tool)
        && let Some(id) = first_capture(&output, &MONITOR_ACK_ID)
    {
        return Some(id);
    }
    let input = raw_input(tool);
    non_empty(input.and_then(|i| i.get("task_id")))
        .or_else(|| non_empty(input.and_then(|i| i.get("taskId"))))
        .or_else(|| {
            input
                .and_then(|i| i.get("task_ids"))
                .and_then(Value::as_array)
                .and_then(|ids| non_empty(ids.first()))
        })
}

/// v1 `isXAiPersistentMonitor` (xaiAcpExtension.ts:298-307): persistent monitors must not hold the
/// turn open.
pub fn is_persistent_monitor(tool: &ToolState) -> bool {
    if !is_monitor_tool(tool) {
        return false;
    }
    if let Some(output) = raw_output(tool)
        && output_type(tool).as_deref() == Some("monitor")
    {
        return output.get("persistent") == Some(&Value::Bool(true));
    }
    raw_input(tool).and_then(|i| i.get("persistent")) == Some(&Value::Bool(true))
}

fn result_record(tool: &ToolState) -> Option<&Map<String, Value>> {
    let output = raw_output(tool)?;
    record(output.get("Result")).or_else(|| record(output.get("result")))
}

/// v1 `structuredTaskIdFromGetOutputTool` (xaiAcpExtension.ts:712-721).
fn structured_task_id(tool: &ToolState) -> Option<String> {
    let result = result_record(tool);
    let output = raw_output(tool);
    non_empty(result.and_then(|r| r.get("task_id")))
        .or_else(|| non_empty(result.and_then(|r| r.get("taskId"))))
        .or_else(|| non_empty(output.and_then(|o| o.get("task_id"))))
        .or_else(|| non_empty(output.and_then(|o| o.get("taskId"))))
}

/// v1 `resultTaskIdFromGetOutputTool` (xaiAcpExtension.ts:723-737).
fn result_task_id(tool: &ToolState, output: Option<&str>) -> Option<String> {
    if let Some(structured) = structured_task_id(tool).filter(|id| is_uuid(id)) {
        return Some(structured);
    }
    first_capture(output?, &TASK_HEADER)
}

fn push_uuid(ids: &mut Vec<String>, value: Option<&Value>) {
    if let Some(id) = non_empty(value).filter(|id| is_uuid(id)) {
        ids.push(id);
    }
}

fn dedup(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// v1 `taskIdsFromGetOutputTool` (xaiAcpExtension.ts:691-710).
fn task_ids_from_get_output(tool: &ToolState, input: Option<&Map<String, Value>>) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(entries) = input
        .and_then(|i| i.get("task_ids"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            push_uuid(&mut ids, Some(entry));
        }
    }
    push_uuid(&mut ids, input.and_then(|i| i.get("task_id")));
    push_uuid(&mut ids, input.and_then(|i| i.get("taskId")));
    if let Some(id) = result_task_id(tool, tool_output_text(tool).as_deref()) {
        ids.push(id);
    }
    dedup(ids)
}

/// v1 `resultFromGetOutputTool` (xaiAcpExtension.ts:739-761).
fn result_from_get_output(tool: &ToolState, output: Option<&str>) -> Option<String> {
    let result = result_record(tool);
    let structured = non_empty(result.and_then(|r| r.get("output")))
        .or_else(|| non_empty(result.and_then(|r| r.get("text"))))
        .or_else(|| decode_byte_text(result.and_then(|r| r.get("output"))));
    if let Some(structured) = structured {
        let cleaned = SUBAGENT_META.replace_all(&structured, "");
        let cleaned = SUBAGENT_RESULT.replace_all(&cleaned, "");
        let cleaned = cleaned.trim();
        return (!cleaned.is_empty()).then(|| cleaned.to_owned());
    }
    let output = output?;
    let body = OUTPUT_MARKER
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or(output)
        .trim();
    (!body.is_empty()).then(|| body.to_owned())
}

/// `/Exit Code:\s*-?(?!0\b)\d+/i`: a code other than a lone 0.
fn has_nonzero_exit_code(output: &str) -> bool {
    EXIT_CODE_DIGIT.captures_iter(output).any(|captures| {
        let digit = captures.get(1).expect("digit");
        if digit.as_str() != "0" {
            return true;
        }
        // JavaScript `\b` after the 0: no boundary when a word character follows.
        output[digit.end()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// v1 `statusFromGetOutputTool` (xaiAcpExtension.ts:763-790).
fn status_from_get_output(tool: &ToolState, output: Option<&str>) -> BackgroundStatus {
    if tool.status.as_deref() == Some("failed") {
        return BackgroundStatus::Failed;
    }
    let result = result_record(tool);
    match lower(non_empty(result.and_then(|r| r.get("status")))).as_deref() {
        Some("completed" | "success") => return BackgroundStatus::Completed,
        Some("failed" | "error") => return BackgroundStatus::Failed,
        Some("running" | "pending") => return BackgroundStatus::Running,
        _ => {}
    }
    if let Some(code) = result
        .and_then(|r| r.get("exit_code"))
        .and_then(Value::as_f64)
    {
        return if code == 0.0 {
            BackgroundStatus::Completed
        } else {
            BackgroundStatus::Failed
        };
    }
    if let Some(output) = output {
        if STATUS_FAILED.is_match(output) || has_nonzero_exit_code(output) {
            return BackgroundStatus::Failed;
        }
        if STATUS_COMPLETED.is_match(output) || STATUS_SUCCESS.is_match(output) {
            return BackgroundStatus::Completed;
        }
        if STATUS_RUNNING.is_match(output) || STATUS_PENDING.is_match(output) {
            return BackgroundStatus::Running;
        }
    }
    // A completed poll RPC does not end its task without task-level status or exit code.
    BackgroundStatus::Running
}

/// v1 `extractXAiBackgroundTaskCompletion` (xaiAcpExtension.ts:309-341).
pub fn background_task_completion(tool: &ToolState) -> Vec<BackgroundMutation> {
    let input = raw_input(tool);
    if !is_get_subagent_output_tool(tool, input) {
        return Vec::new();
    }
    let text = tool_output_text(tool);
    let status = status_from_get_output(tool, text.as_deref());
    let append_output = result_from_get_output(tool, text.as_deref()).unwrap_or_default();
    // Prefer the completed identity from the result/header over the request list.
    if let Some(task_id) =
        structured_task_id(tool).or_else(|| result_task_id(tool, text.as_deref()))
    {
        return vec![BackgroundMutation {
            task_id,
            status,
            append_output,
        }];
    }
    let mut ids = Vec::new();
    if let Some(entries) = input
        .and_then(|i| i.get("task_ids"))
        .and_then(Value::as_array)
    {
        for entry in entries {
            push_uuid(&mut ids, Some(entry));
        }
    }
    push_uuid(&mut ids, input.and_then(|i| i.get("task_id")));
    push_uuid(&mut ids, input.and_then(|i| i.get("taskId")));
    dedup(ids)
        .into_iter()
        .map(|task_id| BackgroundMutation {
            task_id,
            status,
            append_output: append_output.clone(),
        })
        .collect()
}

/// v1 `extractXAiKilledBackgroundTasks` (xaiAcpExtension.ts:343-380): a finished kill ends every
/// task it names; a failed kill proves nothing.
pub fn killed_background_tasks(tool: &ToolState) -> Vec<BackgroundMutation> {
    let title = title_key(tool);
    let input = raw_input(tool);
    let output = raw_output(tool);
    let variant = variant(input);
    let legacy = title.contains("kill_command_or_subagent") || variant.as_deref() == Some("kill");
    let output_kind = output.and_then(|o| o.get("type")).and_then(Value::as_str);
    if !legacy && variant.as_deref() != Some("killtask") && output_kind != Some("KillTask") {
        return Vec::new();
    }
    if tool.status.as_deref() != Some("completed") {
        return Vec::new();
    }
    let outcome = output.and_then(|o| o.get("outcome")).or_else(|| {
        output
            .and_then(|o| o.get("Result"))
            .and_then(Value::as_object)
            .and_then(|r| r.get("outcome"))
    });
    if !legacy
        && let Some(outcome) = outcome
        && outcome != "killed"
        && outcome != "already_exited"
    {
        return Vec::new();
    }
    let mut ids = Vec::new();
    if let Some(entries) = input
        .and_then(|i| i.get("task_ids"))
        .and_then(Value::as_array)
    {
        ids.extend(entries.iter().filter_map(|e| non_empty(Some(e))));
    }
    ids.extend(non_empty(input.and_then(|i| i.get("task_id"))));
    ids.extend(non_empty(input.and_then(|i| i.get("taskId"))));
    dedup(ids)
        .into_iter()
        .map(|task_id| BackgroundMutation {
            task_id,
            status: BackgroundStatus::Completed,
            append_output: String::new(),
        })
        .collect()
}

/// v1 `truncateCommandTitle` (commandTitle.ts:1-7): titles over 80 UTF-16 units are cut to 77
/// (76 when that would split a surrogate pair) plus `...`.
pub fn truncate_command_title(command: &str) -> String {
    let units: Vec<u16> = command.encode_utf16().collect();
    if units.len() <= 80 {
        return command.to_owned();
    }
    let high = |u: u16| (0xD800..=0xDBFF).contains(&u);
    let low = |u: u16| (0xDC00..=0xDFFF).contains(&u);
    let cut = if high(units[76]) && low(units[77]) {
        76
    } else {
        77
    };
    format!("{}...", String::from_utf16_lossy(&units[..cut]))
}

/// v1 `isGenericAcpToolTitle` (xaiAcpExtension.ts:526-529).
fn is_generic_title(title: Option<&str>) -> bool {
    let key = title.unwrap_or("").trim().to_lowercase();
    key.is_empty() || key == "tool" || key == "tool call" || key == "terminal"
}

/// v1 `resolveXAiAcpToolTitle` (xaiAcpExtension.ts:531-557).
fn resolve_title(tool: &ToolState) -> Option<String> {
    if !is_generic_title(tool.title.as_deref()) {
        return tool.title.clone();
    }
    let input = raw_input(tool);
    let description = non_empty(input.and_then(|i| i.get("description")));
    let variant = variant(input);
    if let Some(description) = description {
        if variant.as_deref() == Some("monitor")
            && !description.to_lowercase().starts_with("monitor")
        {
            return Some(format!("Monitor: {description}"));
        }
        return Some(description);
    }
    match variant.as_deref() {
        Some("monitor") => return Some("Monitor".into()),
        Some("task" | "cursortask" | "spawn_subagent") => return Some("Task".into()),
        Some("taskoutput" | "task_output") => return Some("Task output".into()),
        Some(other) => return Some(other.to_owned()),
        None => {}
    }
    let command = non_empty(input.and_then(|i| i.get("command")))
        .or_else(|| non_empty(raw_output(tool).and_then(|o| o.get("command"))));
    if let Some(command) = command {
        return Some(truncate_command_title(&command));
    }
    tool.title.clone()
}

/// v1 `normalizeXAiMcpToolCall` (xaiMcpToolCall.ts:13-57): Grok calls MCP tools through its
/// `use_tool` built-in as `<server>__<tool>` and wraps results as `{type: "MCP", output}`.
pub fn normalize_mcp_tool_call(tool: &mut ToolState) {
    let input = raw_input(tool);
    let tool_name = non_empty(input.and_then(|i| i.get("tool_name"))).unwrap_or_default();
    let use_tool = tool
        .meta
        .as_ref()
        .and_then(|m| m.get("x.ai/tool"))
        .and_then(|t| t.get("name"))
        .and_then(Value::as_str)
        == Some("use_tool");
    let split = tool_name
        .split_once("__")
        .filter(|(server, rest)| !server.is_empty() && !rest.is_empty() && use_tool)
        .map(|(server, rest)| (server.to_owned(), rest.to_owned()));
    let result = raw_output(tool)
        .filter(|o| o.get("type").and_then(Value::as_str) == Some("MCP"))
        .and_then(|o| record(o.get("output")));
    let error = result.and_then(|r| r.get("Error")).and_then(Value::as_str);
    let text = error
        .or_else(|| {
            result
                .and_then(|r| r.get("OkayOutput"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned);
    let is_error = error.is_some();
    if let Some((server, name)) = split {
        let arguments = input
            .and_then(|i| i.get("tool_input"))
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut meta = tool
            .meta
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        meta.insert("is_mcp_tool_call".into(), json!(true));
        tool.meta = Some(Value::Object(meta));
        tool.raw_input = Some(json!({"server": server, "tool": name, "arguments": arguments}));
    }
    if let Some(text) = text {
        let mut output = json!({"content": [{"type": "text", "text": text}]});
        if is_error {
            output["isError"] = json!(true);
        }
        tool.raw_output = Some(output);
    }
}

/// v1 `normalizeXAiAcpToolCallState` (xaiAcpExtension.ts:559-600). Grok 1.0.41 monitor ticks
/// report exit_code 0 before the monitor ends through `_x.ai/task_completed`.
pub fn normalize_tool_call_state(tool: &mut ToolState) {
    normalize_mcp_tool_call(tool);
    if let Some(title) = resolve_title(tool)
        && tool.title.as_deref() != Some(title.as_str())
    {
        tool.title = Some(title);
    }
    let output_type = output_type(tool);
    let reported_running = matches!(tool.status.as_deref(), Some("in_progress" | "pending"));
    if output_type.as_deref() == Some("bash") && !reported_running {
        let exit_code = ["exit_code", "exitCode", "code"].iter().find_map(|key| {
            raw_output(tool)
                .and_then(|o| o.get(*key))
                .and_then(Value::as_f64)
                .filter(|n| n.fract() == 0.0)
        });
        if let Some(code) = exit_code {
            let status =
                if code == 0.0 && tool_output_text(tool).is_none_or(|t| t.trim().is_empty()) {
                    "in_progress"
                } else if code == 0.0 {
                    "completed"
                } else {
                    "failed"
                };
            tool.status = Some(status.into());
            return;
        }
    }
    if background_shell_task_id(tool).is_some() {
        tool.status = Some("in_progress".into());
        return;
    }
    if !is_monitor_tool(tool) {
        return;
    }
    if output_type.as_deref() == Some("monitor") {
        tool.status = Some("in_progress".into());
        return;
    }
    if tool.status.as_deref() == Some("completed")
        && is_monitor_start_ack(tool_output_text(tool).as_deref())
    {
        tool.status = Some("in_progress".into());
    }
}

/// v1 `extractXAiAcpBackgroundToolMutation` (xaiAcpExtension.ts:602-657): monitor output Grok
/// injects as user text.
pub fn background_tool_mutations(text: &str) -> Vec<BackgroundMutation> {
    let mut mutations = Vec::new();
    for pattern in [&*MONITOR_EVENT, &*MONITOR_BATCH] {
        for captures in pattern.captures_iter(text) {
            let Some(task_id) = captures.get(1) else {
                continue;
            };
            let lines = captures.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            mutations.push(BackgroundMutation {
                task_id: task_id.as_str().to_owned(),
                status: BackgroundStatus::Running,
                append_output: if lines.is_empty() {
                    String::new()
                } else {
                    format!("{lines}\n")
                },
            });
        }
    }
    for captures in MONITOR_ENDED.captures_iter(text) {
        let whole = captures.get(0).expect("match");
        let Some(task_id) = captures.get(1) else {
            continue;
        };
        // Only the monitor header describes the outcome.
        let tail = text[whole.end()..].split('\n').next().unwrap_or("");
        let outcome = format!("{}{tail}", whole.as_str().trim());
        let summary = SYSTEM_REMINDER.replace_all(text, "");
        let summary = summary.trim();
        let status = if EXITED_CODE_ZERO.is_match(&outcome) || ENDED_CLEANLY.is_match(&outcome) {
            BackgroundStatus::Completed
        } else if FAILURE_WORDS.is_match(&outcome) {
            BackgroundStatus::Failed
        } else {
            BackgroundStatus::Completed
        };
        mutations.push(BackgroundMutation {
            task_id: task_id.as_str().to_owned(),
            status,
            append_output: if summary.is_empty() {
                "Monitor ended.\n".into()
            } else {
                format!("{summary}\n")
            },
        });
    }
    mutations
}

/// v1 `stripLeadingBalancedParenGroup` (xaiAcpExtension.ts:659-672).
fn strip_leading_paren_group(text: &str) -> &str {
    let trimmed = text.trim_start();
    if !trimmed.starts_with('(') {
        return trimmed;
    }
    let mut depth = 0i32;
    for (index, ch) in trimmed.char_indices() {
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return trimmed[index + 1..].trim_start();
            }
        }
    }
    trimmed
}

/// v1 `extractXAiAcpSubagentEndNotice` (xaiAcpExtension.ts:674-689).
pub fn subagent_end_notice(text: &str) -> Option<SubagentEndNotice> {
    let captures = BACKGROUND_SUBAGENT.captures(text)?;
    let whole = captures.get(0)?;
    let child_session_id = captures.get(1)?.as_str().to_owned();
    // Skip balanced descriptor parentheses so nested titles cannot supply outcome verbs.
    let tail = strip_leading_paren_group(&text[whole.end()..]);
    let status = if COMPLETED_SUCCESSFULLY.is_match(tail) {
        TurnItemStatus::Completed
    } else if END_FAILURE.is_match(tail) {
        TurnItemStatus::Failed
    } else if END_COMPLETED.is_match(tail) {
        TurnItemStatus::Completed
    } else {
        return None;
    };
    Some(SubagentEndNotice {
        child_session_id,
        status,
    })
}

fn subagent_status(status: BackgroundStatus) -> TurnItemStatus {
    match status {
        BackgroundStatus::Running => TurnItemStatus::Running,
        BackgroundStatus::Completed => TurnItemStatus::Completed,
        BackgroundStatus::Failed => TurnItemStatus::Failed,
    }
}

/// v1 `extractXAiAcpSubagentUpdate` (xaiAcpExtension.ts:792-859). Spawn ACKs return at once; the
/// subagent stays running until a child or hydration terminal.
pub fn subagent_update(tool: &ToolState) -> Option<SubagentUpdate> {
    let input = raw_input(tool);
    let output = tool_output_text(tool);

    if is_get_subagent_output_tool(tool, input) {
        if structured_task_id(tool).is_some_and(|id| !is_uuid(&id)) {
            return None;
        }
        let task_ids = task_ids_from_get_output(tool, input);
        let child = result_task_id(tool, output.as_deref())
            .or_else(|| task_ids.first().cloned())
            .or_else(|| child_session_id(output.as_deref()))?;
        return Some(SubagentUpdate {
            native_task_id: tool.tool_call_id.clone(),
            prompt: String::new(),
            title: None,
            model: None,
            status: subagent_status(status_from_get_output(tool, output.as_deref())),
            child_session_id: Some(child),
            result: result_from_get_output(tool, output.as_deref()),
        });
    }

    if !is_spawn_or_task_tool(tool, input) {
        return None;
    }
    let child = child_session_id(output.as_deref());
    let async_ack = is_async_spawn_ack(output.as_deref());
    let legacy_result = output.as_deref().and_then(|output| {
        let cleaned = AGENT_ID_LINE.replace_all(output, "\n");
        let cleaned = SUBAGENT_ID_LINE.replace_all(&cleaned, "\n");
        let cleaned = cleaned.trim();
        (!cleaned.is_empty()).then(|| cleaned.to_owned())
    });
    let status = match tool.status.as_deref() {
        Some("failed") => TurnItemStatus::Failed,
        _ if async_ack => TurnItemStatus::Running,
        Some("completed") => TurnItemStatus::Completed,
        _ => TurnItemStatus::Running,
    };
    Some(SubagentUpdate {
        native_task_id: tool.tool_call_id.clone(),
        prompt: non_empty(input.and_then(|i| i.get("prompt"))).unwrap_or_default(),
        title: non_empty(input.and_then(|i| i.get("description"))),
        model: non_empty(input.and_then(|i| i.get("model"))),
        status,
        child_session_id: child,
        result: if async_ack { None } else { legacy_result },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "11111111-2222-3333-4444-555555555555";
    const B: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn tool(value: Value) -> ToolState {
        let mut state = ToolState {
            tool_call_id: value["toolCallId"].as_str().unwrap_or("t1").to_owned(),
            ..ToolState::default()
        };
        state.merge(&value);
        state
    }

    #[test]
    fn spawn_ack_keeps_the_subagent_running_and_hydration_finishes_it() {
        let spawn = tool(
            json!({"toolCallId": "spawn-1", "title": "Task", "status": "completed",
            "rawInput": {"prompt": "Count files", "description": "Counter", "model": "grok-4"},
            "rawOutput": {"text": format!("Subagent started in background.\nsubagent_id: {A}")}}),
        );
        let update = subagent_update(&spawn).unwrap();
        assert_eq!(update.status, TurnItemStatus::Running);
        assert_eq!(update.child_session_id.as_deref(), Some(A));
        assert_eq!(update.title.as_deref(), Some("Counter"));
        assert_eq!(update.result, None);

        let poll = tool(
            json!({"toolCallId": "poll-1", "title": "get_command_or_subagent_output",
            "status": "completed", "rawInput": {"task_ids": [A]},
            "rawOutput": {"Result": {"task_id": A, "status": "completed",
                "output": "<subagent_meta>x</subagent_meta>42 files"}}}),
        );
        let update = subagent_update(&poll).unwrap();
        assert_eq!(update.status, TurnItemStatus::Completed);
        assert_eq!(update.child_session_id.as_deref(), Some(A));
        assert_eq!(update.result.as_deref(), Some("42 files"));
        assert!(update.prompt.is_empty() && update.title.is_none());
    }

    #[test]
    fn legacy_task_result_drops_agent_id_lines() {
        let task = tool(json!({"title": "task", "status": "completed",
            "rawInput": {"prompt": "p"}, "rawOutput": format!("Agent ID: {A}\nDone: 3 files")}));
        let update = subagent_update(&task).unwrap();
        assert_eq!(update.status, TurnItemStatus::Completed);
        assert_eq!(update.result.as_deref(), Some("Done: 3 files"));
        assert_eq!(update.child_session_id.as_deref(), Some(A));
    }

    #[test]
    fn get_output_status_reads_text_headers() {
        let poll = |text: &str| {
            tool(
                json!({"title": "get_command_or_subagent_output", "status": "completed",
                "rawInput": {"task_id": A}, "rawOutput": text}),
            )
        };
        assert_eq!(
            status_from_get_output(&poll("Exit Code: 2"), Some("Exit Code: 2")),
            BackgroundStatus::Failed
        );
        assert_eq!(
            status_from_get_output(&poll("Exit Code: 0"), Some("Exit Code: 0")),
            BackgroundStatus::Running
        );
        assert_eq!(
            status_from_get_output(&poll("x"), Some("Exit Code: 0x")),
            BackgroundStatus::Failed
        );
        assert_eq!(
            status_from_get_output(&poll("x"), Some("Status: success")),
            BackgroundStatus::Completed
        );
        let completions = background_task_completion(&poll(&format!(
            "=== Task {B} ===\nStatus: completed\n=== Output ===\nhi"
        )));
        assert_eq!(
            completions,
            vec![BackgroundMutation {
                task_id: B.into(),
                status: BackgroundStatus::Completed,
                append_output: "hi".into()
            }]
        );
    }

    #[test]
    fn background_shell_and_monitor_tools_stay_open() {
        let mut started = tool(json!({"title": "Terminal", "status": "completed",
            "rawInput": {"command": "npm run dev"},
            "rawOutput": {"type": "BackgroundTaskStarted", "task_id": "call-1-0"}}));
        normalize_tool_call_state(&mut started);
        assert_eq!(started.status.as_deref(), Some("in_progress"));
        assert_eq!(started.title.as_deref(), Some("npm run dev"));
        assert_eq!(monitor_task_id(&started).as_deref(), Some("call-1-0"));

        let mut monitor = tool(json!({"title": "Tool", "status": "completed",
            "rawInput": {"variant": "Monitor", "description": "watch logs", "persistent": true},
            "rawOutput": {"text": format!("Monitor started (task {A})")}}));
        normalize_tool_call_state(&mut monitor);
        assert_eq!(monitor.status.as_deref(), Some("in_progress"));
        assert_eq!(monitor.title.as_deref(), Some("Monitor: watch logs"));
        assert_eq!(monitor_task_id(&monitor).as_deref(), Some(A));
        assert!(is_persistent_monitor(&monitor));

        let mut tick =
            tool(json!({"status": "completed", "rawOutput": {"type": "Bash", "exit_code": 0}}));
        normalize_tool_call_state(&mut tick);
        assert_eq!(tick.status.as_deref(), Some("in_progress"));
        let mut failed = tool(
            json!({"status": "completed", "rawOutput": {"type": "bash", "exitCode": 1, "output": "boom"}}),
        );
        normalize_tool_call_state(&mut failed);
        assert_eq!(failed.status.as_deref(), Some("failed"));
    }

    #[test]
    fn kill_ends_named_tasks_only_when_it_worked() {
        let kill = |status: &str, outcome: &str| {
            tool(
                json!({"status": status, "rawInput": {"variant": "KillTask", "task_ids": [A, A, B]},
                "rawOutput": {"type": "KillTask", "Result": {"outcome": outcome}}}),
            )
        };
        assert_eq!(
            killed_background_tasks(&kill("completed", "killed")).len(),
            2
        );
        assert!(killed_background_tasks(&kill("completed", "not_found")).is_empty());
        assert!(killed_background_tasks(&kill("failed", "killed")).is_empty());
    }

    #[test]
    fn monitor_text_mutations_and_end_notices() {
        let text = format!(
            "<monitor-event task_id=\"{A}\">line one</monitor-event>\nMonitor {B} ended (exited (code 0))"
        );
        let mutations = background_tool_mutations(&text);
        assert_eq!(
            mutations[0],
            BackgroundMutation {
                task_id: A.into(),
                status: BackgroundStatus::Running,
                append_output: "line one\n".into()
            }
        );
        assert_eq!(mutations[1].task_id, B);
        assert_eq!(mutations[1].status, BackgroundStatus::Completed);
        let failed =
            background_tool_mutations(&format!("Monitor {B} ended: process exited with signal 9"));
        assert_eq!(failed[0].status, BackgroundStatus::Failed);

        assert_eq!(
            subagent_end_notice(&format!(
                "Background subagent {A} (fix failed tests) completed successfully"
            )),
            Some(SubagentEndNotice {
                child_session_id: A.into(),
                status: TurnItemStatus::Completed
            })
        );
        assert_eq!(
            subagent_end_notice(&format!("Background subagent {A} crashed"))
                .unwrap()
                .status,
            TurnItemStatus::Failed
        );
        assert_eq!(
            subagent_end_notice(&format!("Background subagent {A} is thinking")),
            None
        );
    }

    #[test]
    fn command_titles_cut_at_80_utf16_units() {
        assert_eq!(truncate_command_title("ls"), "ls");
        let long = "a".repeat(100);
        assert_eq!(
            truncate_command_title(&long),
            format!("{}...", "a".repeat(77))
        );
        let pair = format!("{}😀{}", "a".repeat(76), "b".repeat(10));
        assert_eq!(
            truncate_command_title(&pair),
            format!("{}...", "a".repeat(76))
        );
    }

    #[test]
    fn mcp_use_tool_is_rewritten_once_merged() {
        let mut state =
            tool(json!({"toolCallId": "m", "_meta": {"x.ai/tool": {"name": "use_tool"}}}));
        state.merge(
            &json!({"rawInput": {"tool_name": "goat__thread_read", "tool_input": {"id": 1}}}),
        );
        state.merge(&json!({"rawOutput": {"type": "MCP", "output": {"OkayOutput": "ok"}}}));
        normalize_tool_call_state(&mut state);
        assert_eq!(
            state.raw_input,
            Some(json!({"server": "goat", "tool": "thread_read", "arguments": {"id": 1}}))
        );
        assert_eq!(state.meta.as_ref().unwrap()["is_mcp_tool_call"], true);
        assert_eq!(
            state.raw_output,
            Some(json!({"content": [{"type": "text", "text": "ok"}]}))
        );
    }
}

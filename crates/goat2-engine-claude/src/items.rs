//! Claude tool calls, questions and plans as GOAT TurnItem bodies.
//!
//! Ported from GOAT v1 (origin/dev 916b5ccc):
//! - tool classification and request kinds: `ClaudeToolFrames.ts:72-128`
//! - command input, file name, request summary, web search patterns/results:
//!   `ClaudeToolFrames.ts:178-183,268-273,455-503`
//! - subagent report text: `ClaudeToolFrames.ts:378-440`
//! - AskUserQuestion questions and answers: `ClaudeAdapterV2.ts:1917-1983`
//! - TodoWrite steps: `ClaudeAdapterV2.ts:1985-2016`
//! - ExitPlanMode plan text: `claudeProposedPlan`, `ClaudeAdapterV2.ts:2166-2175`
//! - approval presentation and removal-check denial: `ClaudeApproval.ts`
//!
//! Tool output is not kept (`outputOmitted`), as the Codex driver does: the log stores tools as
//! name, summary and engine locator only.

use goat2_contracts::{
    ApprovalDecision, ApprovalOption, FileChangeDetail, PlanStep, PlanStepStatus,
    ProviderRequestKind, TurnItemBody, UserInputOption, UserInputQuestion, WebSearchResult,
};
use serde_json::{Map, Value, json};

/// Which TurnItem a tool call becomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolItemType {
    CommandExecution,
    FileChange,
    DynamicTool,
    WebSearch,
}

/// v1 `classifyClaudeNativeTool`.
pub fn classify_tool(tool_name: &str) -> (ToolItemType, ProviderRequestKind) {
    use ProviderRequestKind::{Command, FileChange, FileRead};
    use ToolItemType as T;
    let normalized: String = tool_name
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect();
    match normalized.as_str() {
        "agent" => (T::DynamicTool, Command),
        "bash" => (T::CommandExecution, Command),
        "edit" => (T::FileChange, FileChange),
        "glob" => (T::DynamicTool, FileRead),
        "grep" => (T::DynamicTool, FileRead),
        "ls" => (T::DynamicTool, FileRead),
        "monitor" => (T::DynamicTool, Command),
        "multiedit" => (T::FileChange, FileChange),
        "notebookedit" => (T::FileChange, FileChange),
        "read" => (T::DynamicTool, FileRead),
        "sendmessage" => (T::DynamicTool, Command),
        "task" => (T::DynamicTool, Command),
        "taskstop" => (T::DynamicTool, Command),
        "todowrite" => (T::DynamicTool, Command),
        "toolsearch" => (T::DynamicTool, Command),
        "webfetch" => (T::WebSearch, Command),
        "websearch" => (T::WebSearch, Command),
        "write" => (T::FileChange, FileChange),
        _ => (T::DynamicTool, Command),
    }
}

/// True for the tools that launch a Claude subagent (`Agent`, older `Task`).
pub fn is_subagent_tool(tool_name: &str) -> bool {
    tool_name == "Agent" || tool_name == "Task"
}

fn first_string(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        input
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn json_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// v1 `claudeTruncate`: at most `max` characters.
pub fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// v1 `commandInputFromClaudeTool`.
pub fn command_input(tool_name: &str, input: &Value) -> String {
    first_string(input, &["command", "cmd", "script"])
        .unwrap_or_else(|| format!("{tool_name}: {}", json_text(input)))
}

/// v1 `fileNameFromClaudeTool`.
pub fn file_name(tool_name: &str, input: &Value) -> String {
    first_string(
        input,
        &["file_path", "notebook_path", "path", "filename", "fileName"],
    )
    .unwrap_or_else(|| format!("{tool_name} result"))
}

/// v1 `summarizeClaudeToolRequest`.
pub fn summarize_tool_request(tool_name: &str, input: &Value) -> String {
    if let Some(command) = first_string(input, &["command", "cmd", "script"]) {
        return format!("{tool_name}: {}", truncate(&command, 400));
    }
    if let Some(path) = first_string(input, &["file_path", "path", "filename", "fileName"]) {
        return format!("{tool_name}: {}", truncate(&path, 400));
    }
    let serialized = json_text(input);
    if serialized.chars().count() <= 400 {
        format!("{tool_name}: {serialized}")
    } else {
        format!("{tool_name}: {}...", truncate(&serialized, 397))
    }
}

/// The finished body of a root tool call. `structured` is the user frame's `tool_use_result`.
pub fn tool_body(
    tool_name: &str,
    input: &Value,
    structured: Option<&Value>,
    is_error: bool,
) -> TurnItemBody {
    match classify_tool(tool_name).0 {
        ToolItemType::CommandExecution => TurnItemBody::CommandExecution {
            input: command_input(tool_name, input),
            command_actions: None,
            output: None,
            output_omitted: Some(true),
            output_indicates_failure: is_error.then_some(true),
            exit_code: None,
        },
        ToolItemType::FileChange => {
            let name = file_name(tool_name, input);
            let (additions, deletions) = structured.map(patch_line_counts).unwrap_or((None, None));
            let operation = match structured
                .and_then(|s| s.get("type"))
                .and_then(Value::as_str)
            {
                Some("create") => "create",
                _ => "update",
            };
            TurnItemBody::FileChange {
                file_name: name.clone(),
                additions,
                deletions,
                diff_str: None,
                patch: None,
                patch_omitted: Some(true),
                changes: Some(vec![FileChangeDetail {
                    operation: operation.to_string(),
                    path: name,
                    old_path: None,
                    file_type: None,
                    mime_type: None,
                }]),
            }
        }
        ToolItemType::WebSearch => {
            let pattern = first_string(input, &["query", "url", "pattern"]).or_else(|| {
                structured
                    .and_then(|s| s.get("query"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            TurnItemBody::WebSearch {
                patterns: Some(pattern.into_iter().collect()),
                results: Some(structured.map(web_search_results).unwrap_or_default()),
            }
        }
        ToolItemType::DynamicTool => TurnItemBody::DynamicTool {
            tool_name: Some(tool_name.to_string()),
            input: input.clone(),
            output: None,
            output_omitted: Some(true),
            tool_summary: None,
        },
    }
}

/// v1 `claudeFileChangeLineCounts`: `+`/`-` lines in the structured patch.
fn patch_line_counts(result: &Value) -> (Option<u32>, Option<u32>) {
    let Some(hunks) = result.get("structuredPatch").and_then(Value::as_array) else {
        if result.get("type").and_then(Value::as_str) == Some("create")
            && let Some(content) = result.get("content").and_then(Value::as_str)
        {
            return (Some(content.lines().count() as u32), Some(0));
        }
        return (None, None);
    };
    let (mut added, mut removed) = (0u32, 0u32);
    for line in hunks
        .iter()
        .filter_map(|hunk| hunk.get("lines").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
    {
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (Some(added), Some(removed))
}

/// v1 `webSearchResultsFromClaudeOutput`.
fn web_search_results(output: &Value) -> Vec<WebSearchResult> {
    let Some(results) = output.get("results").and_then(Value::as_array) else {
        return Vec::new();
    };
    results
        .iter()
        .filter_map(|result| result.get("content").and_then(Value::as_array))
        .flatten()
        .map(|content| WebSearchResult {
            title: content
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            url: content
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_owned),
            snippet: None,
        })
        .collect()
}

/// Text of a `tool_result` content (string, or text parts joined by newlines).
pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// v1 `claudeSubagentResultText`: the report without Claude's notes for the parent model.
pub fn subagent_result_text(raw: &str) -> String {
    let mut text = raw.to_string();
    // <tools-used-before-summary>…</tools-used-before-summary> at the start.
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<tools-used-before-summary>")
        && let Some(end) = rest.find("</tools-used-before-summary>")
        && !rest[..end].contains('<')
    {
        text = rest[end + "</tools-used-before-summary>".len()..]
            .trim_start()
            .to_string();
    }
    // Trailing <usage>…</usage>.
    let trimmed_end = text.trim_end();
    if trimmed_end.ends_with("</usage>")
        && let Some(start) = trimmed_end.rfind("<usage>")
        && (start == 0 || trimmed_end[..start].ends_with('\n'))
    {
        text = trimmed_end[..start].trim_end_matches('\n').to_string();
    }
    // Trailing "agentId: <id> (use SendMessage with to: '<id>' …)".
    if let Some(start) = text.rfind("agentId: ") {
        let tail = &text[start..];
        if (start == 0 || text[..start].ends_with('\n'))
            && tail.contains("(use SendMessage with to: '")
            && !tail.trim_end().contains('\n')
        {
            text = text[..start].trim_end_matches('\n').to_string();
        }
    }
    const HAND_BACK: &str =
        "[Subagent hand-back] The text below is the final report of a subagent ";
    if text.starts_with(HAND_BACK)
        && let Some(line_end) = text.find('\n')
        && text[..line_end].ends_with("The report follows:")
    {
        let report = &text[line_end + 1..];
        return report
            .lines()
            .map(|line| line.strip_prefix("  ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
    }
    text
}

/// v1 `isClaudeSubagentAsyncLaunchAck`.
pub fn is_async_launch_ack(structured: Option<&Value>, text: &str) -> bool {
    if let Some(value) = structured
        && (value.get("isAsync").and_then(Value::as_bool) == Some(true)
            || value.get("status").and_then(Value::as_str) == Some("async_launched"))
    {
        return true;
    }
    text.trim_start()
        .starts_with("Async agent launched successfully.")
        || subagent_result_text(text).starts_with("Async agent launched successfully.")
}

/// v1 `claudeUserInputQuestions`: AskUserQuestion input as GOAT questions; the question text is
/// its id, as Claude keys answers by it.
pub fn user_input_questions(input: &Value) -> Vec<UserInputQuestion> {
    let Some(questions) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    questions
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            let question = record.get("question")?.as_str()?.trim().to_string();
            if question.is_empty() {
                return None;
            }
            let header = record
                .get("header")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Question {}", index + 1));
            let options = record
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let label = option.get("label")?.as_str()?.trim().to_string();
                            if label.is_empty() {
                                return None;
                            }
                            let description = option
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|d| !d.is_empty())
                                .map(str::to_owned)
                                .unwrap_or_else(|| label.clone());
                            Some(UserInputOption {
                                label,
                                description,
                                value: None,
                                preview: option
                                    .get("preview")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(UserInputQuestion {
                id: question.clone(),
                header,
                question,
                options,
                multi_select: Some(
                    record.get("multiSelect").and_then(Value::as_bool) == Some(true),
                ),
                allow_custom_answer: None,
                initial_answer: None,
                required: None,
            })
        })
        .collect()
}

/// v1 `claudeSdkUserInputAnswers`: every answer as one string (lists joined with ", ").
pub fn sdk_answers(answers: &Map<String, Value>) -> Map<String, Value> {
    answers
        .iter()
        .map(|(question, answer)| {
            let text = match answer {
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            };
            (question.clone(), json!(text))
        })
        .collect()
}

/// v1 `claudeTodoSteps`.
pub fn todo_steps(input: &Value) -> Vec<PlanStep> {
    let Some(todos) = input.get("todos").and_then(Value::as_array) else {
        return Vec::new();
    };
    todos
        .iter()
        .enumerate()
        .filter_map(|(index, todo)| {
            let text = todo.get("content")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let status = match todo.get("status").and_then(Value::as_str) {
                Some("completed") => PlanStepStatus::Completed,
                Some("in_progress") => PlanStepStatus::Running,
                _ => PlanStepStatus::Pending,
            };
            Some(PlanStep {
                id: format!("todo-{index}"),
                text,
                status,
                duration_anchor_at: None,
                duration_ms: None,
            })
        })
        .collect()
}

/// v1 `claudeProposedPlan`: ExitPlanMode's `plan` text.
pub fn proposed_plan(input: &Value) -> Option<String> {
    input
        .get("plan")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(str::to_owned)
}

/// Remove ANSI/VT control sequences (v1 `NodeUtil.stripVTControlCharacters`).
pub fn strip_vt(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                } else if chars.peek() == Some(&']') {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                } else {
                    chars.next();
                }
            }
            '\u{9b}' => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// v1 `claudeApprovalPresentation`: reason (when it adds something) and the no-standing-grant
/// options.
pub fn approval_presentation(
    prompt: &str,
    decision_reason: Option<&str>,
    suppress_always_allow_rule: bool,
) -> (Option<String>, Option<Vec<ApprovalOption>>) {
    let reason = strip_vt(decision_reason.unwrap_or_default())
        .trim()
        .to_string();
    let reason = (!reason.is_empty() && reason != prompt).then_some(reason);
    let options = suppress_always_allow_rule.then(|| {
        vec![
            ApprovalOption {
                decision: ApprovalDecision::Decline,
                label: "Decline".into(),
                warning: None,
            },
            ApprovalOption {
                decision: ApprovalDecision::Accept,
                label: "Approve".into(),
                warning: None,
            },
        ]
    });
    (reason, options)
}

/// v1 `claudeRemovalDecision`: under bypass, Claude's own removal safety check is answered with
/// a denial the model can act on, without asking the person.
pub fn removal_denial(
    tool_name: &str,
    bypass: bool,
    matched_ask_rule: bool,
    decision_reason: Option<&str>,
) -> Option<String> {
    let reason = strip_vt(decision_reason.unwrap_or_default())
        .trim()
        .to_string();
    let lower = reason.to_lowercase();
    // v1 /^Dangerous rm(?:dir)?\b/i
    let dangerous_rm = ["dangerous rmdir", "dangerous rm"].iter().any(|prefix| {
        lower.starts_with(prefix)
            && lower[prefix.len()..]
                .chars()
                .next()
                .is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    });
    let matches = dangerous_rm
        || lower.contains("dangerous removal")
        || reason == "This shell -c script runs rm and could not be checked"
        || reason == "A permission rule denies a command in this shell -c script";
    if tool_name != "Bash" || !bypass || matched_ask_rule || !matches {
        return None;
    }
    Some(format!(
        "Claude Code's removal safety check denied this command; the user did not reject it. The command did not run. Do not bypass the check by splitting the removal, putting it in a script, or using another tool or shell. If the warning below supplies a safe rewrite, use it and let the same check evaluate it. Otherwise continue the rest of the task without the removal and tell the user what you needed to delete and why. Warning: {reason}"
    ))
}

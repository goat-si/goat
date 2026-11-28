//! Codex thread item projection.
use crate::contract::{
    AssistantMessagePhase, CommandAction, FileChangeDetail, ItemId, MessageId, NativeItemRef,
    NativeRefStrength, PlanId, ThreadId, TurnItem, TurnItemBody, TurnItemStatus,
};
use crate::protocol::server::ThreadItem;
use serde_json::{Value, json};

pub struct ItemContext<'a> {
    pub thread_id: &'a ThreadId,
    /// The Codex thread id (the engine's own thread), for `provider_thread_id`.
    pub codex_thread_id: &'a str,
    pub turn_id: &'a str,
    pub ordinal: u32,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: i64,
}

// v1: apps/server/src/orchestration-v2/Adapters/CodexItemProjection.ts:17-40
pub fn item_status(status: Option<&str>) -> TurnItemStatus {
    match status {
        Some("inProgress") => TurnItemStatus::Running,
        Some("failed") => TurnItemStatus::Failed,
        Some("declined") => TurnItemStatus::Cancelled,
        _ => TurnItemStatus::Completed,
    }
}

// UTC civil-date conversion; milliseconds are split using Euclidean division for pre-epoch times.
pub fn rfc3339_ms(ms: i64) -> String {
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

// v1: apps/server/src/orchestration-v2/Adapters/CodexWebSearch.ts:13-43
pub fn web_search_patterns(query: &str, action: Option<&Value>) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(a) = action {
        match a.get("type").and_then(Value::as_str) {
            Some("search") => {
                if let Some(queries) = a.get("queries").and_then(Value::as_array) {
                    values.extend(queries.iter().filter_map(Value::as_str));
                }
                values.extend(a.get("query").and_then(Value::as_str));
            }
            Some("openPage") => values.extend(a.get("url").and_then(Value::as_str)),
            Some("findInPage") => {
                values.extend(a.get("pattern").and_then(Value::as_str));
                values.extend(a.get("url").and_then(Value::as_str));
            }
            _ => {}
        }
    }
    values.push(query);
    let mut result = Vec::new();
    for value in values {
        let value = value.trim();
        if !value.is_empty() && !result.iter().any(|v| v == value) {
            result.push(value.to_owned());
        }
    }
    result
}

// v1: apps/server/src/provider/CodexCommandActions.ts:17-59
fn command_actions(actions: &[Value]) -> Vec<CommandAction> {
    if actions.len() > 16 {
        return vec![];
    }
    let mut mapped = Vec::new();
    for action in actions {
        let path = action
            .get("path")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_owned());
        let entry = match action.get("type").and_then(Value::as_str) {
            Some("read") => match path {
                Some(path) if !path.is_empty() => CommandAction::Read { path },
                _ => return vec![],
            },
            Some("listFiles") => CommandAction::List { path },
            Some("search") => CommandAction::Search {
                query: action
                    .get("query")
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_owned()),
                path,
            },
            _ => return vec![],
        };
        mapped.push(entry);
    }
    mapped
}

// v1: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:318-348
fn dynamic(name: String, input: Value, completed: bool) -> TurnItemBody {
    TurnItemBody::DynamicTool {
        tool_name: Some(name),
        input,
        output: None,
        output_omitted: completed.then_some(true),
        tool_summary: None,
    }
}

// v1: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4301-4844
pub fn completed_item(item: &ThreadItem, ctx: &ItemContext<'_>) -> Option<TurnItem> {
    project(item, ctx, true)
}

// v1: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:4301-4467
pub fn started_item(item: &ThreadItem, ctx: &ItemContext<'_>) -> Option<TurnItem> {
    project(item, ctx, false)
}

// v1: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:2932-3251,4223-4266,4301-4844
fn project(item: &ThreadItem, ctx: &ItemContext<'_>, completed: bool) -> Option<TurnItem> {
    let id = item.id()?;
    let mut status = if completed {
        TurnItemStatus::Completed
    } else {
        TurnItemStatus::Running
    };
    let mut title = None;
    let body = match item {
        ThreadItem::AgentMessage { text, phase, .. } if completed => {
            TurnItemBody::AssistantMessage {
                phase: match phase.as_deref() {
                    None | Some("final_answer") => Some(AssistantMessagePhase::FinalAnswer),
                    Some("commentary") => Some(AssistantMessagePhase::Commentary),
                    Some("partial_answer") => Some(AssistantMessagePhase::PartialAnswer),
                    _ => None,
                },
                delivery: None,
                message_id: MessageId::from(id),
                text: text.clone(),
                attachments: None,
                streaming: false,
            }
        }
        ThreadItem::Reasoning {
            summary, content, ..
        } if completed => {
            let text = summary
                .iter()
                .chain(content)
                .filter(|s| !s.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            if text.is_empty() {
                return None;
            }
            TurnItemBody::Reasoning {
                text,
                streaming: false,
            }
        }
        ThreadItem::Plan { text, .. } if completed => TurnItemBody::ProposedPlan {
            plan_id: PlanId::from(id),
            markdown: text.clone(),
            streaming: false,
        },
        ThreadItem::CommandExecution {
            command,
            command_actions: actions,
            exit_code,
            status: s,
            ..
        } => {
            if completed {
                status = item_status(s.as_deref());
            }
            TurnItemBody::CommandExecution {
                input: command.clone(),
                command_actions: Some(command_actions(actions)),
                output: None,
                output_omitted: completed.then_some(true),
                output_indicates_failure: None,
                exit_code: *exit_code,
            }
        }
        ThreadItem::FileChange {
            changes, status: s, ..
        } if completed => {
            let first = changes.first()?;
            status = item_status(s.as_deref());
            let details = changes
                .iter()
                .map(|change| {
                    let kind = change
                        .kind
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let dest = change
                        .kind
                        .get("move_path")
                        .or_else(|| change.kind.get("movePath"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty());
                    FileChangeDetail {
                        operation: if kind == "update" && dest.is_some() {
                            "move"
                        } else {
                            kind
                        }
                        .to_owned(),
                        path: dest
                            .filter(|_| kind == "update")
                            .unwrap_or(&change.path)
                            .to_owned(),
                        old_path: dest
                            .filter(|_| kind == "update")
                            .map(|_| change.path.clone()),
                        file_type: None,
                        mime_type: None,
                    }
                })
                .collect();
            TurnItemBody::FileChange {
                file_name: first.path.clone(),
                additions: None,
                deletions: None,
                diff_str: None,
                patch: None,
                patch_omitted: Some(true),
                changes: Some(details),
            }
        }
        ThreadItem::WebSearch { query, action, .. } => {
            let patterns = web_search_patterns(query, action.as_ref());
            TurnItemBody::WebSearch {
                patterns: (!patterns.is_empty()).then_some(patterns),
                results: None,
            }
        }
        ThreadItem::McpToolCall {
            server,
            tool,
            arguments,
            status: s,
            ..
        } => {
            if completed {
                status = item_status(s.as_deref());
            }
            dynamic(format!("{server}.{tool}"), arguments.clone(), completed)
        }
        ThreadItem::DynamicToolCall {
            tool,
            namespace,
            arguments,
            status: s,
            ..
        } => {
            if completed {
                status = item_status(s.as_deref());
            }
            let name = namespace
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map_or_else(|| tool.clone(), |ns| format!("{ns}.{tool}"));
            dynamic(name, arguments.clone(), completed)
        }
        ThreadItem::ImageView { path, .. } if completed => {
            dynamic("view_image".into(), json!({"path": path}), true)
        }
        ThreadItem::ImageGeneration {
            status: s,
            revised_prompt,
            transparent_background,
            input_images,
            failure,
            ..
        } => {
            title = Some("Generate image".into());
            if completed {
                status = if s.as_deref() == Some("cancelled") {
                    TurnItemStatus::Cancelled
                } else if s.as_deref() == Some("failed") || failure.is_some() {
                    TurnItemStatus::Failed
                } else {
                    TurnItemStatus::Completed
                };
            }
            let mut input = serde_json::Map::new();
            if let Some(prompt) = revised_prompt {
                input.insert("prompt".into(), json!(prompt));
            }
            if let Some(value) = transparent_background {
                input.insert("transparent_background".into(), json!(value));
            }
            if let Some(images) = input_images {
                let paths: Vec<_> = images
                    .iter()
                    .filter_map(|v| v.get("path"))
                    .cloned()
                    .collect();
                if !paths.is_empty() {
                    input.insert("inputImages".into(), json!(paths));
                }
            }
            dynamic("image_gen.imagegen".into(), Value::Object(input), completed)
        }
        ThreadItem::ContextCompaction { .. } => {
            title = Some(
                if completed {
                    "Context compacted"
                } else {
                    "Compacting context"
                }
                .into(),
            );
            TurnItemBody::Compaction {
                driver: Some("codex".into()),
                summary: None,
                before_token_count: None,
                after_token_count: None,
            }
        }
        _ => return None,
    };
    let timestamp = rfc3339_ms(ctx.completed_at_ms);
    Some(TurnItem {
        id: ItemId::from(id),
        thread_id: ctx.thread_id.clone(),
        run_id: None,
        // The context contains the GOAT thread ID, not the native Codex thread ID.
        provider_thread_id: Some(ctx.codex_thread_id.to_string()),
        provider_turn_id: Some(ctx.turn_id.into()),
        native_item_ref: Some(NativeItemRef {
            driver: "codex".into(),
            native_id: Some(id.into()),
            strength: NativeRefStrength::Strong,
            fingerprint: None,
            ordinal: None,
        }),
        parent_item_id: None,
        ordinal: ctx.ordinal,
        status,
        title,
        started_at: ctx.started_at_ms.map(rfc3339_ms),
        completed_at: (status != TurnItemStatus::Running).then(|| timestamp.clone()),
        updated_at: timestamp,
        body,
    })
}

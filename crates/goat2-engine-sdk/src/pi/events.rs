//! Pi RPC event projection. Ported from v1 `provider-pi/src/server/adapter.ts`
//! (916b5ccc1b2), `extensionDialog.ts`, `piContentText.ts`, and `piToolOutput.ts`.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use goat2_contracts::{
    EngineItemLocator, ItemId, MessageId, NativeItemRef, NativeRefStrength, ProviderFailure,
    ProviderFailureClass, ProviderRequestKind, RequestId, RequestKind, SubagentOrigin, ThreadId,
    TurnItem, TurnItemBody, TurnItemStatus, UserInputOption, UserInputQuestion,
};
use goat2_engine_api::{EngineEvent, TurnOutcome};
use serde_json::Value;

struct Stream {
    id: String,
    text: String,
    reasoning: bool,
    done: bool,
}
struct Tool {
    name: String,
    args: Value,
    parent: Option<String>,
}

pub(super) struct Translator {
    thread_id: ThreadId,
    engine_ref: String,
    driver: &'static str,
    provider_instance_id: String,
    ordinal: u32,
    message: u64,
    streams: BTreeMap<u64, Stream>,
    tools: HashMap<String, Tool>,
    pending: HashSet<String>,
    compaction: Option<String>,
    interrupted: bool,
    failure: Option<String>,
    finished: bool,
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}
fn content(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.to_owned();
    }
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|x| s(x, "type") == Some("text"))
                .filter_map(|x| s(x, "text"))
                .collect::<String>()
        })
        .unwrap_or_default()
}
// UTC RFC3339 without an extra dependency. Based on the civil-from-days conversion.
fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let z = seconds / 86400 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + i64::from(m <= 2);
    let day = seconds % 86400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        day / 3600,
        day % 3600 / 60,
        day % 60
    )
}
impl Translator {
    pub(super) fn new(
        thread_id: ThreadId,
        engine_ref: String,
        driver: &'static str,
        provider_instance_id: String,
    ) -> Self {
        Self {
            thread_id,
            engine_ref,
            driver,
            provider_instance_id,
            ordinal: 0,
            message: 0,
            streams: BTreeMap::new(),
            tools: HashMap::new(),
            pending: HashSet::new(),
            compaction: None,
            interrupted: false,
            failure: None,
            finished: false,
        }
    }
    pub(super) fn start_turn(&mut self) {
        self.ordinal = 0;
        self.message = 0;
        self.streams.clear();
        self.tools.clear();
        self.pending.clear();
        self.compaction = None;
        self.interrupted = false;
        self.failure = None;
        self.finished = false;
    }
    pub(super) fn interrupt(&mut self) {
        self.interrupted = true;
    }
    /// Call after a request has been resolved or expires. The driver owns RPC replies and timeouts.
    pub(super) fn close_request(&mut self, key: &str) -> Option<EngineEvent> {
        self.pending
            .remove(key)
            .then(|| EngineEvent::RequestClosed {
                key: key.to_owned(),
            })
    }
    fn item_id(turn: &str, native: &str) -> ItemId {
        ItemId::new(format!("pi:{}:{}:{}", turn.len(), turn, native))
    }
    fn item(
        &mut self,
        turn: &str,
        native: &str,
        status: TurnItemStatus,
        title: Option<String>,
        body: TurnItemBody,
        parent: Option<&str>,
    ) -> TurnItem {
        let at = now();
        let ordinal = self.ordinal;
        self.ordinal = self.ordinal.saturating_add(1);
        TurnItem {
            id: Self::item_id(turn, native),
            thread_id: self.thread_id.clone(),
            run_id: None,
            provider_thread_id: Some(self.engine_ref.clone()),
            provider_turn_id: Some(turn.to_owned()),
            native_item_ref: Some(NativeItemRef {
                driver: self.driver.into(),
                native_id: Some(native.to_owned()),
                strength: NativeRefStrength::Strong,
                fingerprint: None,
                ordinal: None,
            }),
            parent_item_id: parent.map(|p| Self::item_id(turn, p)),
            ordinal,
            status,
            title,
            started_at: Some(at.clone()),
            completed_at: (status != TurnItemStatus::Waiting && status != TurnItemStatus::Running)
                .then(|| at.clone()),
            updated_at: at,
            body,
        }
    }
    fn emit(
        &mut self,
        turn: &str,
        native: &str,
        status: TurnItemStatus,
        title: Option<String>,
        body: TurnItemBody,
        parent: Option<&str>,
    ) -> EngineEvent {
        let item = self.item(turn, native, status, title, body, parent);
        EngineEvent::ItemCompleted {
            turn_id: turn.into(),
            item: Box::new(item),
            locator: Some(EngineItemLocator {
                turn_id: turn.into(),
                item_id: native.into(),
            }),
        }
    }
    fn finish_stream(
        &mut self,
        turn: &str,
        index: u64,
        replacement: Option<&str>,
    ) -> Option<EngineEvent> {
        let stream = self.streams.get_mut(&index)?;
        if stream.done {
            return None;
        }
        stream.done = true;
        if let Some(text) = replacement.filter(|t| !t.is_empty()) {
            stream.text = text.into();
        }
        if stream.text.is_empty() {
            return None;
        }
        let (id, text, reasoning) = (stream.id.clone(), stream.text.clone(), stream.reasoning);
        let body = if reasoning {
            TurnItemBody::Reasoning {
                text,
                streaming: false,
            }
        } else {
            TurnItemBody::AssistantMessage {
                phase: None,
                delivery: None,
                message_id: MessageId::new(Self::item_id(turn, &id).0),
                text,
                attachments: None,
                streaming: false,
            }
        };
        Some(self.emit(turn, &id, TurnItemStatus::Completed, None, body, None))
    }
    fn finish_streams(&mut self, turn: &str) -> Vec<EngineEvent> {
        let indices: Vec<_> = self.streams.keys().copied().collect();
        indices
            .into_iter()
            .filter_map(|i| self.finish_stream(turn, i, None))
            .collect()
    }
    pub(super) fn translate(&mut self, record: &Value, turn_id: &str) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        match s(record, "type").unwrap_or("") {
            "message_start" if s(&record["message"], "role") == Some("assistant") => {
                self.message += 1;
                self.streams.clear();
            }
            "message_update" => {
                let d = &record["assistantMessageEvent"];
                let kind = s(d, "type").unwrap_or("");
                let index = d.get("contentIndex").and_then(Value::as_u64).unwrap_or(0);
                if matches!(
                    kind,
                    "text_start"
                        | "thinking_start"
                        | "text_delta"
                        | "thinking_delta"
                        | "text_end"
                        | "thinking_end"
                ) {
                    let item = self.streams.entry(index).or_insert_with(|| Stream {
                        id: format!("{turn_id}:m{}:c{index}", self.message),
                        text: String::new(),
                        reasoning: kind.starts_with("thinking"),
                        done: false,
                    });
                    if kind.ends_with("_start") && !item.done {
                        item.text.clear();
                    }
                    if kind.ends_with("_delta") && !item.done {
                        let delta = s(d, "delta").unwrap_or("");
                        item.text.push_str(delta);
                        if !item.reasoning && !delta.is_empty() {
                            out.push(EngineEvent::TextDelta {
                                turn_id: turn_id.into(),
                                item_id: Self::item_id(turn_id, &item.id),
                                text: delta.into(),
                            });
                        }
                    }
                    if kind.ends_with("_end")
                        && let Some(e) = self.finish_stream(
                            turn_id,
                            index,
                            s(d, "content").or_else(|| s(d, "thinking")),
                        )
                    {
                        out.push(e);
                    }
                }
            }
            "message_end" if s(&record["message"], "role") == Some("assistant") => {
                out.extend(self.finish_streams(turn_id));
                let m = &record["message"];
                if s(m, "stopReason") == Some("error") {
                    self.failure = Some(
                        s(m, "errorMessage")
                            .unwrap_or("Pi reported a model error.")
                            .into(),
                    );
                }
                if s(m, "stopReason") == Some("aborted") {
                    self.interrupted = true;
                }
            }
            "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
                let Some(id) = s(record, "toolCallId") else {
                    return out;
                };
                let phase = s(record, "type").unwrap_or("");
                if phase == "tool_execution_start" {
                    self.tools.insert(
                        id.into(),
                        Tool {
                            name: s(record, "toolName").unwrap_or("tool").into(),
                            args: record.get("args").cloned().unwrap_or(Value::Null),
                            parent: s(record, "parentToolCallId").map(str::to_owned),
                        },
                    );
                }
                let tool = self.tools.get(id);
                let name = s(record, "toolName")
                    .or_else(|| tool.map(|t| t.name.as_str()))
                    .unwrap_or("tool")
                    .to_owned();
                let args = record
                    .get("args")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .or_else(|| tool.map(|t| t.args.clone()))
                    .unwrap_or(Value::Null);
                let parent = s(record, "parentToolCallId")
                    .map(str::to_owned)
                    .or_else(|| tool.and_then(|t| t.parent.clone()));
                let result = if phase == "tool_execution_end" {
                    &record["result"]
                } else {
                    &record["partialResult"]
                };
                if name == "subagent"
                    || (self.driver == "omo"
                        && matches!(
                            name.as_str(),
                            "task" | "team_create" | "workpool" | "workflow"
                        ))
                {
                    self.subagents(&mut out, turn_id, id, result, phase == "tool_execution_end");
                }
                if phase != "tool_execution_end" {
                    return out;
                }
                let error = record
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let status = if error {
                    if self.interrupted {
                        TurnItemStatus::Interrupted
                    } else {
                        TurnItemStatus::Failed
                    }
                } else {
                    TurnItemStatus::Completed
                };
                let text = content(&result["content"]);
                let body = if name == "bash" || name == "powershell" {
                    TurnItemBody::CommandExecution {
                        input: s(&args, "command").unwrap_or("").into(),
                        command_actions: None,
                        output: (!text.is_empty()).then_some(text),
                        output_omitted: None,
                        output_indicates_failure: None,
                        exit_code: result
                            .pointer("/structuredContent/exit_code")
                            .or_else(|| result.pointer("/details/exitCode"))
                            .and_then(Value::as_i64)
                            .and_then(|n| i32::try_from(n).ok()),
                    }
                } else if (name == "edit" || name == "write")
                    && (s(&args, "path").or_else(|| s(&args, "file_path"))).is_some()
                {
                    TurnItemBody::FileChange {
                        file_name: s(&args, "path")
                            .or_else(|| s(&args, "file_path"))
                            .unwrap_or("")
                            .into(),
                        additions: None,
                        deletions: None,
                        diff_str: s(&result["details"], "patch")
                            .map(str::to_owned)
                            .or_else(|| (error && !text.trim().is_empty()).then_some(text)),
                        patch: None,
                        patch_omitted: None,
                        changes: None,
                    }
                } else {
                    let structured = result.get("structuredContent");
                    let output = if let Some(value) = structured {
                        Some(
                            serde_json::json!({"content": result.get("content").cloned().unwrap_or(Value::Array(vec![])), "structuredContent": value}),
                        )
                    } else if !text.is_empty() {
                        Some(Value::String(text))
                    } else {
                        result
                            .get("content")
                            .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                            .map(|v| serde_json::json!({"content":v}))
                    };
                    TurnItemBody::DynamicTool {
                        tool_name: Some(name.clone()),
                        input: if args.is_null() {
                            serde_json::json!({})
                        } else {
                            args
                        },
                        output,
                        output_omitted: None,
                        tool_summary: None,
                    }
                };
                out.push(self.emit(turn_id, id, status, Some(name), body, parent.as_deref()));
            }
            "compaction_start" => {
                self.compaction = Some(format!("{turn_id}:compaction:{}", self.ordinal));
            }
            "compaction_end" => {
                let id = self
                    .compaction
                    .take()
                    .unwrap_or_else(|| format!("{turn_id}:compaction:{}", self.ordinal));
                let result = &record["result"];
                let status = if record["aborted"] == true {
                    TurnItemStatus::Cancelled
                } else if result.is_null() {
                    TurnItemStatus::Failed
                } else {
                    TurnItemStatus::Completed
                };
                let summary = s(result, "summary").map(str::to_owned).or_else(|| {
                    (status == TurnItemStatus::Failed).then(|| {
                        s(record, "errorMessage")
                            .unwrap_or("Pi context compaction failed.")
                            .to_owned()
                    })
                });
                if record["willRetry"] == true {
                    self.failure = None;
                }
                out.push(self.emit(
                    turn_id,
                    &id,
                    status,
                    Some("Compaction".into()),
                    TurnItemBody::Compaction {
                        driver: Some(self.driver.into()),
                        summary,
                        before_token_count: result.get("tokensBefore").and_then(Value::as_u64),
                        after_token_count:
                            result.get("estimatedTokensAfter").and_then(Value::as_u64),
                    },
                    None,
                ));
            }
            "extension_ui_request" => self.request(&mut out, record, turn_id),
            "extension_error" => {
                let message = s(record, "error")
                    .unwrap_or("Pi extension error.")
                    .to_owned();
                let id = format!("extension-error:{turn_id}:{}", self.ordinal);
                out.push(self.error(turn_id, &id, message));
            }
            "auto_retry_start" => {
                self.failure = Some(
                    s(record, "errorMessage")
                        .unwrap_or("Pi provider request failed.")
                        .into(),
                );
            }
            "auto_retry_end" if record["success"] == true => {
                self.failure = None;
            }
            "agent_settled" if !self.finished => {
                out.extend(self.finish_streams(turn_id));
                for key in std::mem::take(&mut self.pending) {
                    out.push(EngineEvent::RequestClosed { key });
                }
                let outcome = if self.interrupted || record["aborted"] == true {
                    TurnOutcome::Interrupted
                } else if let Some(reason) = self.failure.take() {
                    let id = format!("error:{turn_id}:{}", self.ordinal);
                    out.push(self.error(turn_id, &id, reason.clone()));
                    TurnOutcome::Failed { reason }
                } else {
                    TurnOutcome::Done
                };
                self.finished = true;
                out.push(EngineEvent::TurnFinished {
                    turn_id: turn_id.into(),
                    outcome,
                });
            }
            _ => {}
        }
        out
    }
    fn error(&mut self, turn: &str, id: &str, message: String) -> EngineEvent {
        self.emit(
            turn,
            id,
            TurnItemStatus::Failed,
            None,
            TurnItemBody::Error {
                failure: ProviderFailure {
                    class: ProviderFailureClass::ProviderError,
                    message,
                    code: None,
                    retryable: None,
                    reset_at: None,
                    log: None,
                },
                retry: None,
            },
            None,
        )
    }
    fn request(&mut self, out: &mut Vec<EngineEvent>, event: &Value, turn: &str) {
        let Some(method) = s(event, "method") else {
            return;
        };
        if !matches!(method, "confirm" | "select" | "input" | "editor") {
            return;
        }
        let Some(id) = s(event, "id") else {
            return;
        };
        if !self.pending.insert(id.into()) {
            return;
        }
        let title = s(event, "title")
            .filter(|t| !t.trim().is_empty())
            .unwrap_or("Question");
        let detail = s(event, "message")
            .or_else(|| s(event, "placeholder"))
            .filter(|t| !t.trim().is_empty());
        let request_id = RequestId::new(Self::item_id(turn, id).0);
        let summary = detail.unwrap_or(title).to_owned();
        let body = if method == "confirm" {
            let file = matches!(title, "Allow edit?" | "Allow write?");
            TurnItemBody::ApprovalRequest {
                request_id,
                request_kind: if file {
                    ProviderRequestKind::FileChange
                } else {
                    ProviderRequestKind::Command
                },
                prompt: Some(summary.clone()),
                reason: None,
                options: None,
            }
        } else {
            let options = if method == "select" {
                event
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(|v| UserInputOption {
                                label: if v.is_empty() { "Empty value" } else { v }.into(),
                                description: if v.is_empty() { "Empty value" } else { v }.into(),
                                value: Some(v.into()),
                                preview: None,
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            } else if method == "input" {
                vec![UserInputOption {
                    label: "Submit empty value".into(),
                    description: "Send an empty string to the extension.".into(),
                    value: Some("".into()),
                    preview: None,
                }]
            } else {
                vec![]
            };
            TurnItemBody::UserInputRequest {
                request_id,
                questions: vec![UserInputQuestion {
                    id: id.into(),
                    header: if detail.is_some() { title } else { "Question" }.into(),
                    question: summary.clone(),
                    options,
                    multi_select: None,
                    allow_custom_answer: None,
                    initial_answer: (method == "editor")
                        .then(|| s(event, "prefill").unwrap_or("").into()),
                    required: None,
                }],
            }
        };
        let item = self.item(
            turn,
            id,
            TurnItemStatus::Waiting,
            Some(title.into()),
            body,
            None,
        );
        out.push(EngineEvent::RequestOpened {
            turn_id: turn.into(),
            key: id.into(),
            item_id: Some(item.id.clone()),
            kind: if method == "confirm" {
                RequestKind::Approval
            } else {
                RequestKind::Question
            },
            summary,
            item: Some(Box::new(item)),
        });
    }
    fn subagents(
        &mut self,
        out: &mut Vec<EngineEvent>,
        turn: &str,
        tool: &str,
        result: &Value,
        ended: bool,
    ) {
        let Some(results) = result.pointer("/details/results").and_then(Value::as_array) else {
            return;
        };
        for (index, entry) in results.iter().enumerate() {
            let (Some(agent), Some(task)) = (s(entry, "agent"), s(entry, "task")) else {
                continue;
            };
            let suffix = s(entry, "asyncMemberId")
                .map(str::to_owned)
                .or_else(|| {
                    entry
                        .get("step")
                        .and_then(Value::as_i64)
                        .map(|n| n.to_string())
                })
                .unwrap_or_else(|| index.to_string());
            let id = format!("{tool}:subagent:{suffix}");
            let finished = ended || entry["finished"] == true;
            let status = match s(entry, "asyncStatus") {
                Some("pending") => TurnItemStatus::Pending,
                Some("waiting") => TurnItemStatus::Waiting,
                Some("running") => TurnItemStatus::Running,
                Some("completed") => TurnItemStatus::Completed,
                Some("failed") => TurnItemStatus::Failed,
                Some("interrupted") => TurnItemStatus::Interrupted,
                _ if finished && s(entry, "stopReason") == Some("aborted") => {
                    TurnItemStatus::Interrupted
                }
                _ if finished
                    && (s(entry, "stopReason") == Some("error")
                        || entry.get("exitCode").and_then(Value::as_i64).unwrap_or(0) != 0) =>
                {
                    TurnItemStatus::Failed
                }
                _ if finished => TurnItemStatus::Completed,
                _ => TurnItemStatus::Running,
            };
            let failed = matches!(status, TurnItemStatus::Failed | TurnItemStatus::Interrupted);
            let text = if failed {
                s(entry, "errorMessage")
                    .or_else(|| s(entry, "stderr"))
                    .unwrap_or("")
                    .to_owned()
            } else {
                String::new()
            };
            let text = if text.is_empty() {
                entry
                    .get("messages")
                    .and_then(Value::as_array)
                    .and_then(|a| {
                        a.iter()
                            .rev()
                            .filter(|m| s(m, "role") == Some("assistant"))
                            .map(|m| content(&m["content"]))
                            .find(|t| !t.is_empty())
                    })
                    .unwrap_or_default()
            } else {
                text
            };
            if finished {
                let body = TurnItemBody::Subagent {
                    subagent_id: id.clone(),
                    origin: SubagentOrigin::ProviderNative,
                    driver: self.driver.into(),
                    provider_instance_id: self.provider_instance_id.clone(),
                    child_thread_id: None,
                    prompt: task.into(),
                    progress: None,
                    result: (!text.is_empty()).then_some(text),
                };
                out.push(self.emit(turn, &id, status, Some(agent.into()), body, Some(tool)));
            } else {
                out.push(EngineEvent::SubagentUpdate {
                    turn_id: Some(turn.into()),
                    subagent_id: id,
                    status,
                    title: Some(agent.into()),
                    progress: (!text.is_empty()).then_some(text),
                });
            }
        }
    }
}

//! The TurnItem subset from GOAT v1 `OrchestrationV2TurnItem` that Part 1 renders.
//!
//! Source: goat-si/goat dev `packages/contracts/src/orchestrationV2.ts` (TurnItem union and
//! its base fields). Field names and `type` tags are unchanged so the chat renderer draws
//! these as v1 did. Dropped from the base: `nodeId` (no execution-node tree in GOAT 2) and the
//! tool icon/surface fields (Part 2). Variants Part 1 does not produce are omitted.
//!
//! v1 `Schema.NullOr(T)` is `Option<T>` written as `null`; v1 `Schema.optional(T)` is
//! `Option<T>` that is omitted when absent (`field?: T` in TypeScript).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{ItemId, MessageId, PlanId, RequestId, RunId, ThreadId};

/// v1 `OrchestrationV2TurnItemStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnItemStatus {
    Idle,
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

/// v1 `OrchestrationV2NativeRefStrength`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NativeRefStrength {
    Strong,
    Weak,
    None,
}

/// v1 `OrchestrationV2ProviderRef`: where the engine keeps this item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NativeItemRef {
    pub driver: String,
    pub native_id: Option<String>,
    pub strength: NativeRefStrength,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ordinal: Option<u32>,
}

/// v1 `OrchestrationV2Actor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    User,
    Agent,
    System,
}

/// v1 `OrchestrationV2CreationSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CreationSource {
    Web,
    Mobile,
    Mcp,
    Provider,
    Server,
}

/// v1 `OrchestrationV2UserMessageInputIntent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UserMessageInputIntent {
    TurnStart,
    QueuedTurn,
    Steer,
    PromotedQueuedToSteer,
}

/// v1 `AssistantMessagePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssistantMessagePhase {
    Commentary,
    PartialAnswer,
    FinalAnswer,
}

/// v1 assistant `delivery: "async"`: sent mid-turn, apart from the turn's answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AssistantDelivery {
    Async,
}

/// Where a large body or attachment lives inside the thread folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    /// Path relative to the thread folder, e.g. `blobs/<itemId>.txt`.
    pub path: String,
    /// Full size in bytes.
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub size_bytes: u64,
}

/// v1 `ChatAttachment` kinds Part 1 accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChatAttachmentType {
    Image,
    File,
}

/// v1 `ChatImageAttachment` / `ChatFileAttachment`, plus where the bytes live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    #[serde(rename = "type")]
    pub kind: ChatAttachmentType,
    pub id: String,
    pub name: String,
    pub mime_type: String,
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob: Option<BlobRef>,
}

/// v1 `OrchestrationV2PlanStep` status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    Running,
    Completed,
}

/// v1 `OrchestrationV2PlanStep`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub id: String,
    pub text: String,
    pub status: PlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_anchor_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(with = "crate::serde_util::safe_u64_opt")]
    #[schemars(with = "Option<u64>")]
    #[ts(as = "Option<u64>")]
    pub duration_ms: Option<u64>,
}

/// v1 `OrchestrationV2UserInputQuestion` option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<String>,
}

/// v1 `OrchestrationV2UserInputQuestion`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<UserInputOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub multi_select: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allow_custom_answer: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub initial_answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub required: Option<bool>,
}

/// v1 `ProviderRequestKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderRequestKind {
    Command,
    FileRead,
    FileChange,
    McpElicitation,
    Permission,
}

/// v1 `ProviderApprovalDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    AcceptAlways,
    Decline,
    Cancel,
}

/// v1 `ProviderApprovalOption`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    pub decision: ApprovalDecision,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub warning: Option<String>,
}

/// v1 `OrchestrationV2FileChangeDetail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDetail {
    pub operation: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub old_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
}

/// v1 `OrchestrationV2CommandAction`: what a read-only shell command does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandAction {
    Read {
        path: String,
    },
    List {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
    },
    Search {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path: Option<String>,
    },
}

/// v1 `OrchestrationV2WebSearchResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub snippet: Option<String>,
}

/// v1 `OrchestrationV2NoticeSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NoticeSeverity {
    Info,
    Warning,
}

/// v1 `OrchestrationV2ProviderFailureClass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailureClass {
    UsageLimit,
    ProviderError,
    TransportError,
    PermissionError,
    ValidationError,
    Unknown,
}

/// v1 `OrchestrationV2ProviderFailure`. Producers redact credentials before construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub class: ProviderFailureClass,
    pub message: String,
    pub code: Option<String>,
    pub retryable: Option<bool>,
    /// v1 `optional(NullOr(IsoDateTime))`: absent, `null` and a value are distinct.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<String>")]
    pub reset_at: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub log: Option<String>,
}

/// v1 `OrchestrationV2ProviderRetry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetry {
    pub attempt: u32,
    pub max_attempts: Option<u32>,
    /// v1 `NullOr`: written as `null` when unknown; a missing field reads as `null`.
    #[serde(default, with = "crate::serde_util::safe_u64_opt")]
    #[schemars(with = "Option<u64>")]
    #[ts(as = "Option<u64>")]
    pub retry_delay_ms: Option<u64>,
}

/// v1 subagent `origin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubagentOrigin {
    ProviderNative,
    AppOwned,
}

/// A finished item, as `item.completed` stores it and the chat renderer draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnItem {
    pub id: ItemId,
    pub thread_id: ThreadId,
    pub run_id: Option<RunId>,
    pub provider_thread_id: Option<String>,
    pub provider_turn_id: Option<String>,
    pub native_item_ref: Option<NativeItemRef>,
    pub parent_item_id: Option<ItemId>,
    pub ordinal: u32,
    pub status: TurnItemStatus,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
    #[serde(flatten)]
    pub body: TurnItemBody,
}

/// The `type`-tagged part of a [TurnItem].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TurnItemBody {
    UserMessage {
        created_by: Actor,
        creation_source: CreationSource,
        message_id: MessageId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sender_thread_id: Option<ThreadId>,
        input_intent: UserMessageInputIntent,
        text: String,
        attachments: Vec<ChatAttachment>,
    },
    AssistantMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        phase: Option<AssistantMessagePhase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delivery: Option<AssistantDelivery>,
        message_id: MessageId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<ChatAttachment>>,
        streaming: bool,
    },
    Reasoning {
        text: String,
        streaming: bool,
    },
    ProposedPlan {
        plan_id: PlanId,
        markdown: String,
        streaming: bool,
    },
    TodoList {
        plan_id: PlanId,
        steps: Vec<PlanStep>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        explanation: Option<String>,
    },
    UserInputRequest {
        request_id: RequestId,
        questions: Vec<UserInputQuestion>,
    },
    ApprovalRequest {
        request_id: RequestId,
        request_kind: ProviderRequestKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        options: Option<Vec<ApprovalOption>>,
    },
    FileChange {
        file_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        additions: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        deletions: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        diff_str: Option<String>,
        /// This edit alone as a git-style patch. Omitted from the log; read it from the engine.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        patch: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        patch_omitted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        changes: Option<Vec<FileChangeDetail>>,
    },
    CommandExecution {
        input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        command_actions: Option<Vec<CommandAction>>,
        /// Omitted from the log (`outputOmitted: true`); read it from the engine.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output_omitted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output_indicates_failure: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        exit_code: Option<i32>,
    },
    WebSearch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        patterns: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        results: Option<Vec<WebSearchResult>>,
    },
    /// MCP and dynamic tool calls.
    DynamicTool {
        tool_name: Option<String>,
        input: serde_json::Value,
        /// Absent when there is no output; an explicit `null` output is kept as `null`.
        #[serde(
            default,
            deserialize_with = "crate::serde_util::present_value",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        output: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output_omitted: Option<bool>,
        /// A muted one-line outcome for the row; display only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tool_summary: Option<String>,
    },
    Compaction {
        driver: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        summary: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[serde(with = "crate::serde_util::safe_u64_opt")]
        #[schemars(with = "Option<u64>")]
        #[ts(as = "Option<u64>")]
        before_token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[serde(with = "crate::serde_util::safe_u64_opt")]
        #[schemars(with = "Option<u64>")]
        #[ts(as = "Option<u64>")]
        after_token_count: Option<u64>,
    },
    SystemNotice {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        severity: Option<NoticeSeverity>,
    },
    Error {
        failure: ProviderFailure,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        retry: Option<ProviderRetry>,
    },
    /// An engine-native subagent (Codex collab agent). GOAT worker threads use `child.*` events.
    Subagent {
        subagent_id: String,
        origin: SubagentOrigin,
        driver: String,
        provider_instance_id: String,
        child_thread_id: Option<ThreadId>,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        progress: Option<String>,
        result: Option<String>,
    },
}

impl TurnItemBody {
    /// The wire `type` tag.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Self::UserMessage { .. } => "user_message",
            Self::AssistantMessage { .. } => "assistant_message",
            Self::Reasoning { .. } => "reasoning",
            Self::ProposedPlan { .. } => "proposed_plan",
            Self::TodoList { .. } => "todo_list",
            Self::UserInputRequest { .. } => "user_input_request",
            Self::ApprovalRequest { .. } => "approval_request",
            Self::FileChange { .. } => "file_change",
            Self::CommandExecution { .. } => "command_execution",
            Self::WebSearch { .. } => "web_search",
            Self::DynamicTool { .. } => "dynamic_tool",
            Self::Compaction { .. } => "compaction",
            Self::SystemNotice { .. } => "system_notice",
            Self::Error { .. } => "error",
            Self::Subagent { .. } => "subagent",
        }
    }
}

//! `goat.jsonl`: the per-thread append-only log, and the only source of truth.
//!
//! Line 1 is a [LogHeader]. Every later line is a [LogLine]: `{v, seq, at, type, ...}`.
//! `seq` starts at 1 and grows by 1 within a thread. Only finished things are written:
//! no text deltas, no tool output updates, no view state.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::card::{
    EngineConfig, EngineDriver, EngineRef, FollowUpMode, ParentRef, RequestKind, ThreadCard,
    ThreadKind,
};
use crate::ids::{BotId, Epoch, InputId, ItemId, ProjectId, RequestId, RunId, ThreadId};
use crate::limits::LOG_FORMAT_VERSION;
use crate::subscribe::ThreadCursor;
use crate::turn_item::{BlobRef, ChatAttachment, TurnItem};

/// First line of `goat.jsonl`: `{"v":1,"epoch":"<uuid>"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogHeader {
    pub v: u32,
    pub epoch: Epoch,
}

impl LogHeader {
    pub fn new(epoch: Epoch) -> Self {
        Self {
            v: LOG_FORMAT_VERSION,
            epoch,
        }
    }
}

/// One event line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Line format version, [LOG_FORMAT_VERSION] when written by this build.
    pub v: u32,
    /// Per-thread sequence, starting at 1.
    pub seq: u64,
    /// RFC 3339 UTC timestamp.
    pub at: String,
    #[serde(flatten)]
    pub event: LogEvent,
}

impl LogLine {
    pub fn new(seq: u64, at: impl Into<String>, event: LogEvent) -> Self {
        Self {
            v: LOG_FORMAT_VERSION,
            seq,
            at: at.into(),
            event,
        }
    }
}

/// The 14 log events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "type")]
pub enum LogEvent {
    #[serde(rename = "thread.created")]
    ThreadCreated(ThreadCreated),
    #[serde(rename = "thread.changed")]
    ThreadChanged(ThreadChanged),
    #[serde(rename = "input.accepted")]
    InputAccepted(InputAccepted),
    #[serde(rename = "input.delivered")]
    InputDelivered(InputDelivered),
    #[serde(rename = "run.started")]
    RunStarted(RunStarted),
    #[serde(rename = "run.accepted")]
    RunAccepted(RunAccepted),
    #[serde(rename = "item.completed")]
    ItemCompleted(ItemCompleted),
    #[serde(rename = "request.opened")]
    RequestOpened(RequestOpened),
    #[serde(rename = "request.resolved")]
    RequestResolved(RequestResolved),
    #[serde(rename = "run.finished")]
    RunFinished(RunFinished),
    #[serde(rename = "child.started")]
    ChildStarted(ChildStarted),
    #[serde(rename = "child.reported")]
    ChildReported(ChildReported),
    #[serde(rename = "user.notified")]
    UserNotified(UserNotified),
    #[serde(rename = "checkpoint")]
    Checkpoint(Checkpoint),
}

impl LogEvent {
    /// Every wire `type` tag, in declaration order.
    pub const TYPE_TAGS: [&'static str; 14] = [
        "thread.created",
        "thread.changed",
        "input.accepted",
        "input.delivered",
        "run.started",
        "run.accepted",
        "item.completed",
        "request.opened",
        "request.resolved",
        "run.finished",
        "child.started",
        "child.reported",
        "user.notified",
        "checkpoint",
    ];

    /// The wire `type` tag.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Self::ThreadCreated(_) => "thread.created",
            Self::ThreadChanged(_) => "thread.changed",
            Self::InputAccepted(_) => "input.accepted",
            Self::InputDelivered(_) => "input.delivered",
            Self::RunStarted(_) => "run.started",
            Self::RunAccepted(_) => "run.accepted",
            Self::ItemCompleted(_) => "item.completed",
            Self::RequestOpened(_) => "request.opened",
            Self::RequestResolved(_) => "request.resolved",
            Self::RunFinished(_) => "run.finished",
            Self::ChildStarted(_) => "child.started",
            Self::ChildReported(_) => "child.reported",
            Self::UserNotified(_) => "user.notified",
            Self::Checkpoint(_) => "checkpoint",
        }
    }

    /// The run this event belongs to, if any.
    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::InputDelivered(e) => Some(&e.run_id),
            Self::RunStarted(e) => Some(&e.run_id),
            Self::RunAccepted(e) => Some(&e.run_id),
            Self::ItemCompleted(e) => Some(&e.run_id),
            Self::RequestOpened(e) => e.run_id.as_ref(),
            Self::RunFinished(e) => Some(&e.run_id),
            Self::UserNotified(e) => e.run_id.as_ref(),
            _ => None,
        }
    }
}

/// `thread.created`: kind, title, parent, engine settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCreated {
    pub kind: ThreadKind,
    pub title: String,
    pub project_id: Option<ProjectId>,
    pub bot_id: Option<BotId>,
    pub parent: Option<ParentRef>,
    pub engine: EngineConfig,
    pub follow_up_mode: FollowUpMode,
}

/// `thread.changed`: only the fields that changed are present.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChanged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub follow_up_mode: Option<FollowUpMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub archived: Option<bool>,
}

/// Who put an input in the mailbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum InputSource {
    User,
    /// A child's result, after the parent's `child.reported` line.
    Child {
        thread_id: ThreadId,
    },
    System,
}

/// How an input is admitted while a run may be active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Steer,
    Followup,
    Collect,
    /// Only from the explicit "stop and send" button.
    Interrupt,
}

/// `input.accepted`: an input entered the thread's mailbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputAccepted {
    pub input_id: InputId,
    pub from: InputSource,
    /// The mode the sender asked for. What reached the engine is in `input.delivered`.
    pub mode: InputMode,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_request_id: Option<String>,
}

/// How an input was handed to the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveredAs {
    /// Into the running turn (Codex `turn/steer`).
    Steer,
    /// As a new turn (Codex `turn/start`).
    Turn,
}

/// What the engine answered for a delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryOutcome {
    Accepted,
    /// A declined steer stays queued and is later delivered as a turn with the same inputId.
    Declined,
    /// No answer (transport failure, restart).
    Unknown,
}

/// `input.delivered`: the engine answered a steer or a turn start carrying this input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputDelivered {
    pub input_id: InputId,
    pub run_id: RunId,
    #[serde(rename = "as")]
    pub delivered_as: DeliveredAs,
    pub outcome: DeliveryOutcome,
}

/// `run.started`: written to disk before anything is sent to the engine (send boundary).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: RunId,
    pub input_ids: Vec<InputId>,
    /// Host generation; outputs from older generations are dropped.
    pub generation: u64,
    pub engine_ref: Option<EngineRef>,
}

/// The engine's own id for an accepted turn (Codex `turn/start` response `turnId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EngineTurnRef {
    pub driver: EngineDriver,
    pub id: String,
}

/// `run.accepted`: the engine acknowledged the turn. On restart, a run with `run.accepted` or
/// any item/request settles as `interrupted`; a run with only `run.started` settles as
/// `unknown` and is never re-sent automatically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunAccepted {
    pub run_id: RunId,
    pub engine_turn_ref: EngineTurnRef,
}

/// Engine location of an item: `(turnId, itemId)` inside the engine's own record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EngineItemLocator {
    pub turn_id: String,
    pub item_id: String,
}

/// `item.completed`: a finished item. User messages and final assistant text are copied;
/// tool calls keep name, summary and engine locator only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemCompleted {
    pub run_id: RunId,
    /// The item; its `id` is the itemId.
    pub item: TurnItem,
    pub engine_locator: Option<EngineItemLocator>,
    /// Set when a body above [crate::limits::BLOB_THRESHOLD_BYTES] moved to `blobs/`; the item
    /// keeps only the start of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob: Option<BlobRef>,
}

/// `request.opened`: a person is needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestOpened {
    pub request_id: RequestId,
    pub run_id: Option<RunId>,
    /// The approval/question item, when the request came from the engine.
    pub item_id: Option<ItemId>,
    pub kind: RequestKind,
    /// At most [crate::limits::NEEDS_YOU_SUMMARY_MAX_CHARS] characters.
    pub summary: String,
}

/// How a request ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestOutcome {
    Approved,
    ApprovedForSession,
    Declined,
    Answered,
    Cancelled,
    /// `resend` request: send the unknown run again.
    Resend,
    /// `resend` request: drop the unknown run.
    Dropped,
}

/// `request.resolved`: the person's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestResolved {
    pub request_id: RequestId,
    pub outcome: RequestOutcome,
    /// Free-text answer or note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// Structured answers by question id, for question requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answers: Option<serde_json::Map<String, serde_json::Value>>,
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Done,
    Failed,
    Interrupted,
    /// Sent but not known to have reached the engine. Never re-sent automatically.
    Unknown,
}

/// `run.finished`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunFinished {
    pub run_id: RunId,
    pub outcome: RunOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// `child.started` (parent log).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildStarted {
    pub child_thread_id: ThreadId,
    pub task: String,
    /// The parent's tool-call item that started the child.
    pub by_item_id: ItemId,
}

/// Result status carried to the parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChildResultStatus {
    Done,
    Failed,
    Interrupted,
    Unknown,
    /// The host restarted while the child ran.
    InterruptedByRestart,
}

/// `child.reported` (parent log): written before the parent's model is called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildReported {
    pub child_thread_id: ThreadId,
    pub child_run_id: Option<RunId>,
    pub status: ChildResultStatus,
    /// The child's final answer as is, at most [crate::limits::CHILD_SUMMARY_MAX_BYTES] bytes.
    pub summary: String,
    /// Where the result sits in the child's log.
    pub child_cursor: ThreadCursor,
}

/// `user.notified` kind (MCP `send_to_user`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NotifyKind {
    Ack,
    Result,
}

/// `user.notified`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserNotified {
    pub run_id: Option<RunId>,
    pub kind: NotifyKind,
    pub text: String,
}

/// Fold state beyond the card: what a reader needs to continue folding from a checkpoint
/// without reading earlier lines.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fold {
    /// The run between `run.started` and `run.finished`, if any.
    pub active_run_id: Option<RunId>,
    /// Inputs accepted but not yet delivered, in order.
    pub queued_input_ids: Vec<InputId>,
    /// Requests still open (including `resend`), so the inbox renders without earlier lines.
    pub open_requests: Vec<RequestOpened>,
    pub counters: FoldCounters,
}

/// Running totals kept by the fold.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FoldCounters {
    pub inputs: u64,
    pub runs: u64,
    pub items: u64,
}

/// `checkpoint`: card and fold as of this line, written at the end of every run.
/// Replay after a reset starts from the latest checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// The card with `appliedSeq` equal to this line's seq.
    pub card: ThreadCard,
    pub fold: Fold,
}

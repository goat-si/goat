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
use crate::model::{ModelSelection, RuntimeMode};
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
    /// Per-thread sequence, starting at 1, at most [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
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

/// The 15 log events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "type")]
pub enum LogEvent {
    #[serde(rename = "thread.created")]
    ThreadCreated(ThreadCreated),
    #[serde(rename = "thread.changed")]
    ThreadChanged(ThreadChanged),
    #[serde(rename = "input.accepted")]
    InputAccepted(InputAccepted),
    #[serde(rename = "input.changed")]
    InputChanged(InputChanged),
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
    pub const TYPE_TAGS: [&'static str; 15] = [
        "thread.created",
        "thread.changed",
        "input.accepted",
        "input.changed",
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
            Self::InputChanged(_) => "input.changed",
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
    pub model_selection: Option<ModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_mode: Option<RuntimeMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub follow_up_mode: Option<FollowUpMode>,
    /// v1 `archivedAt`: a timestamp archives the thread, `null` unarchives it.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<String>")]
    pub archived_at: Option<Option<String>>,
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
    /// Idempotency key, kept so the host dedupes across restarts. Host-generated for child and
    /// system inputs.
    pub client_request_id: String,
}

/// `input.changed`: a person edited an input that is still queued (`edit_queued`,
/// `cancel_queued`, `reorder_queued`, `promote_to_steer`). Only the changed fields are present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InputChanged {
    pub input_id: InputId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    /// `promote_to_steer` writes `mode: steer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<InputMode>,
    /// `cancel_queued`: the input leaves the queue and is never delivered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cancelled: Option<bool>,
    /// `reorder_queued`: 0-based index in the queue after the change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<u32>,
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
    /// Refused because GOAT never owned the native turn. Fails closed: the input leaves the queue
    /// and is never retried.
    Refused,
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
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
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
    /// Kind `decision`: the choices offered (v1 `goat_decision_request`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options: Option<Vec<DecisionOption>>,
    /// Kind `decision`: the recommended option id. Silence never approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recommended: Option<String>,
}

/// One choice of a `decision` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecisionOption {
    pub id: String,
    pub label: String,
    /// v1 `DecisionOption.consequence` (required).
    pub consequence: String,
}

/// How a request ended. Approval outcomes are v1 `ProviderApprovalDecision` literals
/// (`providerPolicy.ts`); `answered`, `decided`, `resend` and `dropped` are GOAT 2 kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestOutcome {
    Accept,
    AcceptForSession,
    AcceptAlways,
    Decline,
    /// Approval cancelled, or a question/decision withdrawn.
    Cancel,
    Answered,
    /// `decision` request: the person picked `optionId`.
    Decided,
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
    /// `decision` request: the chosen option id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub option_id: Option<String>,
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
    /// v1 run status `completed`.
    Completed,
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
    Completed,
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

/// Fold state beyond the card: what a reader (or the store after a crash) needs to continue
/// folding from a checkpoint without reading earlier lines.
///
/// Fold rules (lane A store): `input.accepted` queues; `input.delivered` accepted leaves the
/// queue, declined stays queued and leaves `activeRunInputIds`, unknown moves into the active
/// run's hold. At `run.finished`, run inputs still queued are delivered if
/// `activeRunReachedEngine`, held if the outcome is `unknown`, else stay queued; an `unknown`
/// outcome opens request `resend:<runId>` (kind `resend`) holding them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Fold {
    /// The run between `run.started` and `run.finished`, if any.
    pub active_run_id: Option<RunId>,
    /// Inputs carried by the active run's `run.started`.
    pub active_run_input_ids: Vec<InputId>,
    /// True once `run.accepted`, an `item.completed` or `request.opened` for the active run, or
    /// `input.delivered {as: turn, outcome: accepted}` for one of its inputs is folded (steer
    /// deliveries do not count). Restart settlement: true -> `interrupted`, false -> `unknown`.
    pub active_run_reached_engine: bool,
    /// Inputs accepted but not yet delivered, in order, with `input.changed` edits applied, so a
    /// client gets the whole queue from a checkpoint.
    pub queued_inputs: Vec<QueuedInput>,
    /// Inputs whose delivery is ambiguous, held by a resend request (one hold per run).
    pub held_inputs: Vec<HeldInputs>,
    /// Requests still open (including `resend`), so the inbox renders without earlier lines.
    pub open_requests: Vec<RequestOpened>,
    /// Children started and not yet reported; `card.children.running` is its length.
    pub running_child_ids: Vec<ThreadId>,
    /// Outcome of the last finished run, for the `failed` status after later events.
    pub last_run_outcome: Option<RunOutcome>,
    pub counters: FoldCounters,
}

/// One queued (or held) input as it stands after `input.changed` edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    pub input_id: InputId,
    pub text: String,
    pub mode: InputMode,
    pub source: InputSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
}

/// Inputs held by a `resend` request. `request.resolved` outcome `resend` returns them to the
/// front of `queuedInputs`; `dropped` discards them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeldInputs {
    /// `resend:<runId>`.
    pub request_id: RequestId,
    pub run_id: RunId,
    pub inputs: Vec<QueuedInput>,
}

/// Running totals kept by the fold. Each at most [crate::limits::MAX_SAFE_WIRE_INTEGER].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FoldCounters {
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub inputs: u64,
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub runs: u64,
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
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

/// A `goat.jsonl` event line as a reader sees it: a known event, or a newer event type this build
/// does not know, which readers skip (format freeze rule: new event types are additive).
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedLine {
    Known(Box<LogLine>),
    Unknown { v: u32, seq: u64, type_tag: String },
}

/// Parse one event line (not the header). Unknown `type` values become [ParsedLine::Unknown];
/// a known type with a bad payload is an error.
pub fn parse_log_line(text: &str) -> Result<ParsedLine, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let type_tag = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or_default();
    if LogEvent::TYPE_TAGS.contains(&type_tag) {
        return serde_json::from_value(value).map(|line| ParsedLine::Known(Box::new(line)));
    }
    #[derive(Deserialize)]
    struct Envelope {
        v: u32,
        #[serde(with = "crate::serde_util::safe_u64")]
        seq: u64,
        #[serde(rename = "type")]
        type_tag: String,
    }
    let envelope: Envelope = serde_json::from_value(value)?;
    Ok(ParsedLine::Unknown {
        v: envelope.v,
        seq: envelope.seq,
        type_tag: envelope.type_tag,
    })
}

//! Subscriptions between the host and UI clients (WebSocket JSON frames).
//!
//! Two subscriptions only: `subscribeCards(after)` on the card index cursor `(epoch, cardSeq)`
//! and `subscribeThread(threadId, after)` on the thread cursor `(epoch, seq)`. A thread
//! subscription replays finished events, sends `thread.caught_up` once, then goes live,
//! including append-only text for items still streaming.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::bot::{BotFace, BotProfile};
use crate::card::{FollowUpMode, ThreadCard, ThreadKind};
use crate::ids::{BotId, Epoch, InputId, ItemId, RequestId, RunId, ThreadId};
use crate::log::{InputMode, LogLine, RequestOutcome};
use crate::model::{ModelSelection, RuntimeMode};
use crate::turn_item::ChatAttachment;

/// Position in one thread's `goat.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursor {
    pub epoch: Epoch,
    /// At most [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub seq: u64,
}

/// Position in the card index.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardCursor {
    pub epoch: Epoch,
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub card_seq: u64,
}

/// Why the host discards the client's state and replays from a checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResetReason {
    /// The log or index was rebuilt under a new epoch.
    EpochChanged,
    /// The cursor points past the end or is malformed.
    InvalidCursor,
    /// The thread folder no longer exists.
    ThreadMissing,
    /// More than [crate::limits::REPLAY_MAX_EVENTS] events or
    /// [crate::limits::REPLAY_MAX_BYTES] behind; the host sends the latest checkpoint instead.
    TooFarBehind,
}

/// Frames a client sends: subscriptions, then commands. Every command carries `reqId` (matched by
/// `command_result`) and `clientRequestId` (idempotency: the host applies one id once and replays
/// its result).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ClientFrame {
    /// Start `subscribeCards`. No cursor means "from the start".
    SubscribeCards {
        sub_id: String,
        after: Option<CardCursor>,
    },
    /// Start `subscribeThread`. No cursor means "from the latest checkpoint".
    SubscribeThread {
        sub_id: String,
        thread_id: ThreadId,
        after: Option<ThreadCursor>,
    },
    Unsubscribe {
        sub_id: String,
    },
    /// Older lines for scroll-back: up to `limit` lines with `seq < before`.
    ReadPage {
        req_id: String,
        thread_id: ThreadId,
        #[serde(with = "crate::serde_util::safe_u64")]
        #[ts(as = "u64")]
        #[schemars(with = "u64")]
        before: u64,
        limit: u32,
    },
    /// The client's text offset did not match; resend this item's text from offset 0.
    ResyncItem {
        sub_id: String,
        item_id: ItemId,
    },
    Pong {
        at: String,
    },
    /// Put an input in a thread's mailbox. `mode` is the sender's request; `interrupt` only from
    /// the explicit "stop and send" button.
    SendInput {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        text: String,
        mode: InputMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        attachments: Option<Vec<ChatAttachment>>,
    },
    /// Create a thread, optionally with its first input.
    StartThread {
        req_id: String,
        client_request_id: String,
        kind: ThreadKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        bot_id: Option<BotId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        parent: Option<ThreadId>,
        model_selection: ModelSelection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        runtime_mode: Option<RuntimeMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mode: Option<StartMode>,
    },
    /// Stop the thread's current run (the explicit Stop button).
    StopThread {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
    },
    /// Release a queue held after a stop.
    ResumeQueue {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
    },
    /// Answer an open request. For kind `resend` the outcome is `resend` or `dropped`.
    ResolveRequest {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        request_id: RequestId,
        outcome: RequestOutcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        answers: Option<serde_json::Map<String, serde_json::Value>>,
        /// Kind `decision`: the chosen option id (with outcome `decided`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        option_id: Option<String>,
    },
    ArchiveThread {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        archived: bool,
    },
    RenameThread {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        title: String,
    },
    /// Change engine settings or follow-up mode; written as `thread.changed`, applies from the
    /// next run.
    ChangeThread {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        model_selection: Option<ModelSelection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        runtime_mode: Option<RuntimeMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        follow_up_mode: Option<FollowUpMode>,
    },
    /// Replace the text of a queued input (`input.changed {text}`).
    EditQueued {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        input_id: InputId,
        text: String,
    },
    /// Remove a queued input (`input.changed {cancelled: true}`).
    CancelQueued {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        input_id: InputId,
    },
    /// Set the queue order; `inputIds` lists every queued input in the new order.
    ReorderQueued {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        input_ids: Vec<InputId>,
    },
    /// Steer a queued input into the running turn (`input.changed {mode: steer}`).
    PromoteToSteer {
        req_id: String,
        client_request_id: String,
        thread_id: ThreadId,
        input_id: InputId,
    },
    /// Create a member bot and its `bot` thread.
    CreateBot {
        req_id: String,
        client_request_id: String,
        name: String,
        purpose: String,
        face: BotFace,
        model_selection: ModelSelection,
    },
}

impl ClientFrame {
    /// The command's `clientRequestId`, the idempotency key. `None` for subscription frames.
    pub fn client_request_id(&self) -> Option<&str> {
        match self {
            Self::SendInput {
                client_request_id, ..
            }
            | Self::StartThread {
                client_request_id, ..
            }
            | Self::StopThread {
                client_request_id, ..
            }
            | Self::ResumeQueue {
                client_request_id, ..
            }
            | Self::ResolveRequest {
                client_request_id, ..
            }
            | Self::ArchiveThread {
                client_request_id, ..
            }
            | Self::RenameThread {
                client_request_id, ..
            }
            | Self::ChangeThread {
                client_request_id, ..
            }
            | Self::EditQueued {
                client_request_id, ..
            }
            | Self::CancelQueued {
                client_request_id, ..
            }
            | Self::ReorderQueued {
                client_request_id, ..
            }
            | Self::PromoteToSteer {
                client_request_id, ..
            }
            | Self::CreateBot {
                client_request_id, ..
            } => Some(client_request_id),
            _ => None,
        }
    }
}

/// `start_thread.mode`: whether the starter waits for the thread's result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StartMode {
    Async,
    Wait,
}

/// `command_result.value`: ids the command created or touched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandValue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<ThreadId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bot_id: Option<BotId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input_id: Option<InputId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub request_id: Option<RequestId>,
    /// True when this `clientRequestId` was already applied and the earlier result is returned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deduped: Option<bool>,
}

/// Failure class, v1 `AgentSurfaceErrorCode` (`agentSurface/envelope.ts`). The domain cause goes in
/// [CommandError::reason].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentSurfaceErrorCode {
    InvalidRequest,
    Unauthenticated,
    PermissionDenied,
    NotFound,
    Conflict,
    Unavailable,
    Timeout,
    Expired,
    Cancelled,
    Internal,
    ResourceExhausted,
    FailedPrecondition,
    UnknownOutcome,
}

/// `command_result.error`, the v1 `AgentSurfaceError` shape.
///
/// Reasons the host uses (code / reason): `not_found` / `thread_not_found`, `request_not_found`,
/// `bot_not_found`; `permission_denied` / `not_allowed`; `conflict` / `steer_refused` (a steer
/// refused at admission, nothing sent), `idempotency_conflict` (same `clientRequestId`, different
/// arguments); `failed_precondition` / `not_queued` (the input left the queue, or
/// `reorder_queued` did not list exactly the queued inputs); `resource_exhausted` / `child_budget`,
/// `payload_too_large`; `invalid_request` / `invalid_request`; `internal` / `internal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: AgentSurfaceErrorCode,
    /// The domain's own code, unchanged.
    pub reason: String,
    pub message: String,
    /// True only when repeating the command cannot duplicate an effect.
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub details: Option<serde_json::Value>,
}

/// Frames the host sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HostFrame {
    /// Drop every card held for this subscription; fresh cards follow.
    CardsReset {
        sub_id: String,
        reason: ResetReason,
        epoch: Epoch,
    },
    /// A changed (or, after a reset, current) card. `card.cardSeq` is the new cursor.
    CardChanged {
        sub_id: String,
        card: Box<ThreadCard>,
    },
    /// A deleted thread.
    CardRemoved {
        sub_id: String,
        thread_id: ThreadId,
        #[serde(with = "crate::serde_util::safe_u64")]
        #[ts(as = "u64")]
        #[schemars(with = "u64")]
        card_seq: u64,
    },
    CardsCaughtUp {
        sub_id: String,
        cursor: CardCursor,
    },
    /// Drop everything held for this thread; replay from the latest checkpoint follows.
    ThreadReset {
        sub_id: String,
        thread_id: ThreadId,
        reason: ResetReason,
        epoch: Epoch,
    },
    /// One finished log line.
    ThreadEvent {
        sub_id: String,
        thread_id: ThreadId,
        line: Box<LogLine>,
    },
    /// Replay done; live events follow.
    ThreadCaughtUp {
        sub_id: String,
        thread_id: ThreadId,
        cursor: ThreadCursor,
    },
    /// Append-only streaming text for an unfinished item. Not stored. `offset` counts UTF-16
    /// code units (JavaScript `string.length`) of text already sent for this item; on
    /// reconnect the host first sends the whole text so far with offset 0. One append never
    /// splits a UTF-16 surrogate pair.
    TextAppend {
        sub_id: String,
        thread_id: ThreadId,
        item_id: ItemId,
        #[serde(with = "crate::serde_util::safe_u64")]
        #[ts(as = "u64")]
        #[schemars(with = "u64")]
        offset: u64,
        text: String,
    },
    /// Answer to [ClientFrame::ReadPage], oldest line first.
    Page {
        req_id: String,
        thread_id: ThreadId,
        lines: Vec<LogLine>,
        has_more: bool,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sub_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<String>,
        code: String,
        message: String,
    },
    /// Sent every [crate::limits::PING_INTERVAL_SECS] seconds.
    Ping {
        at: String,
    },
    /// The one reply to every command frame: `ok` with `value`, or not `ok` with `error`.
    CommandResult {
        req_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        value: Option<CommandValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<CommandError>,
    },
    /// A bot was created or changed (on the `subscribe_cards` stream).
    BotChanged {
        sub_id: String,
        bot: Box<BotProfile>,
    },
    /// A bot was removed (on the `subscribe_cards` stream).
    BotRemoved {
        sub_id: String,
        bot_id: BotId,
    },
}

impl HostFrame {
    pub fn command_ok(req_id: impl Into<String>, value: CommandValue) -> Self {
        Self::CommandResult {
            req_id: req_id.into(),
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    pub fn command_err(req_id: impl Into<String>, error: CommandError) -> Self {
        Self::CommandResult {
            req_id: req_id.into(),
            ok: false,
            value: None,
            error: Some(error),
        }
    }
}

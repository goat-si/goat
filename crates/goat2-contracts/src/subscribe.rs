//! Subscriptions between the host and UI clients (WebSocket JSON frames).
//!
//! Two subscriptions only: `subscribeCards(after)` on the card index cursor `(epoch, cardSeq)`
//! and `subscribeThread(threadId, after)` on the thread cursor `(epoch, seq)`. A thread
//! subscription replays finished events, sends `thread.caught_up` once, then goes live,
//! including append-only text for items still streaming.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::card::ThreadCard;
use crate::ids::{Epoch, ItemId, ThreadId};
use crate::log::LogLine;

/// Position in one thread's `goat.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCursor {
    pub epoch: Epoch,
    pub seq: u64,
}

/// Position in the card index.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardCursor {
    pub epoch: Epoch,
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

/// Frames a client sends.
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
}

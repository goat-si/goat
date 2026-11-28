//! Bot attention: what makes a bot ask for the person (inbox badges, alerts).
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc) `packages/contracts/src/channelBotAttention.ts`.
//! GOAT 2 has threads where v1 had channel tasks, so `taskId` is `threadId`; environment routing
//! is not carried (Part 2 is local).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{BotId, RequestId, ThreadId};

/// v1 `GoatBotAlerts`: which events reach the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GoatBotAlerts {
    NeedsYou,
    NeedsYouAndResults,
    Off,
}

/// v1 `ChannelAttentionKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChannelAttentionKind {
    Question,
    Approval,
    SignIn,
    Failed,
    Finished,
}

/// v1 `ChannelAttentionEvent`: one attention event for a bot's thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAttentionEvent {
    pub bot_id: BotId,
    /// The thread that needs attention (v1 `taskId`).
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub request_id: Option<RequestId>,
    pub event_id: String,
    /// At most [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub sequence: u64,
    pub kind: ChannelAttentionKind,
    pub generation: u32,
    /// RFC 3339 UTC timestamp.
    pub occurred_at: String,
    pub bot_name: String,
}

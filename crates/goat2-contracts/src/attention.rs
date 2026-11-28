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

/// v1 `ChannelAttentionRequest.kind`: an engine request, or a durable approval handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChannelAttentionRequestKind {
    Runtime,
    Handoff,
}

/// v1 `ChannelAttentionRequest` (`ChannelTaskApprovalRef` fields + kind): which request on which thread
/// needs the person. v1 `host` / `environmentId` are not carried (Part 2 is local).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAttentionRequest {
    pub request_id: RequestId,
    pub thread_id: ThreadId,
    pub kind: ChannelAttentionRequestKind,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub request: Option<ChannelAttentionRequest>,
    pub event_id: String,
    /// At most [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub sequence: u64,
    pub kind: ChannelAttentionKind,
    /// v1 `Schema.Int`, within the safe wire integer range.
    #[serde(with = "crate::serde_util::safe_i64")]
    #[ts(as = "i64")]
    #[schemars(with = "i64")]
    pub generation: i64,
    /// RFC 3339 UTC timestamp.
    pub occurred_at: String,
    pub bot_name: String,
}

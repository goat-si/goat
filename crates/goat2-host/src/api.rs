//! The host's internal API: what the MCP and WebSocket modules call, implemented by the core.
//!
//! Keeping this seam narrow lets `mcp/` and `ws/` be built and tested against a test double,
//! and lets the core change without touching the transports.

pub mod commands;
pub mod envelope;

use std::sync::Arc;

use async_trait::async_trait;
use goat2_contracts::{
    Epoch, ItemId, LogLine, ResetReason, RunId, ThreadCard, ThreadId, ThreadKind,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

pub use commands::{
    AgentSurfaceErrorCode, BotProfile, Command, CommandError, CommandReply, CommandValue, Reason,
    command_error, is_command,
};
pub use envelope::{ErrorCode, Handoff, NextCall, SurfaceError, SurfaceResult};

use crate::store::ThreadStore;

// ---------------------------------------------------------------- live updates

/// A card index change, broadcast to every `subscribe_cards`.
#[derive(Debug, Clone)]
pub enum CardUpdate {
    Changed(Arc<ThreadCard>),
    Removed { thread_id: ThreadId, card_seq: u64 },
    BotChanged(Arc<BotProfile>),
    BotRemoved { bot_id: goat2_contracts::BotId },
}

/// A live thread change, broadcast to every `subscribe_thread` of that thread.
#[derive(Debug, Clone)]
pub enum ThreadLive {
    /// A finished log line, already on disk.
    Line(Arc<LogLine>),
    /// Append-only streaming text: `offset` = UTF-16 units already sent for this item.
    Text {
        item_id: ItemId,
        offset: u64,
        stream_kind: goat2_contracts::ContentStreamKind,
        text: String,
    },
    /// The item finished (its `item.completed` line follows or preceded); drop its buffer.
    TextDone { item_id: ItemId },
    /// A live usage snapshot, never stored as a frame.
    Usage {
        usage: Box<goat2_contracts::ThreadTokenUsageSnapshot>,
        updated_at: String,
    },
    /// The thread's log was replaced or removed.
    Reset { epoch: Epoch, reason: ResetReason },
}

/// Text of an item still streaming, sent whole (offset 0) when a subscriber joins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingItem {
    pub item_id: ItemId,
    pub stream_kind: goat2_contracts::ContentStreamKind,
    pub text: String,
}

/// What the WebSocket module needs from the host.
#[async_trait]
pub trait WsHost: Send + Sync + 'static {
    /// The UI bearer token (`GOAT2_HOST_TOKEN` or generated).
    fn ui_token(&self) -> String;
    /// Read-only store access for replay and pages (call body reads in `spawn_blocking`).
    fn store(&self) -> Arc<dyn ThreadStore>;
    /// Current bot profiles.
    fn bots(&self) -> Vec<BotProfile>;
    /// Subscribe before reading so no change is missed; dedupe by `cardSeq`.
    fn watch_cards(&self) -> broadcast::Receiver<CardUpdate>;
    /// Subscribe to a thread's live changes plus a snapshot of items still streaming.
    /// Subscribe before reading the log; dedupe lines by `seq`.
    fn watch_thread(
        &self,
        thread_id: &ThreadId,
    ) -> (broadcast::Receiver<ThreadLive>, Vec<StreamingItem>);
    /// Run one UI command (a [Command] frame for which [is_command] is true). Deduped by
    /// `clientRequestId`; the caller answers with the current frame's `reqId`.
    async fn command(&self, command: Command) -> CommandReply;
    /// The `providers` list: the current value (`None` until the first probes finished) and
    /// every change.
    fn watch_providers(&self) -> tokio::sync::watch::Receiver<crate::providers::ProviderList> {
        tokio::sync::watch::channel(None).1
    }
    /// Record how long the host itself was stalled, so silent-connection checks can ignore it.
    fn stalled_ms_since(&self, since: std::time::Instant) -> u64 {
        let _ = since;
        0
    }
}

// ---------------------------------------------------------------- MCP

/// What a per-thread MCP token stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpGrant {
    pub thread_id: ThreadId,
    pub process_generation: u64,
    pub host_generation: u64,
}

/// The caller of an MCP tool: the run active in the token's thread at call time.
/// Server-issued; never taken from tool arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub thread_id: ThreadId,
    pub run_id: RunId,
    pub kind: ThreadKind,
}

/// `thread.start` / `goat_thread_start`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStartArgs {
    pub task: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// `async` (default) or `wait` (v1 task.create mode; owner 2026-11-28).
    #[serde(default)]
    pub mode: Option<goat2_contracts::StartMode>,
    /// For `mode: wait`: how long the call may block, at most 60 s.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

/// `thread.send`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadSendArgs {
    pub thread_id: ThreadId,
    pub text: String,
    #[serde(default)]
    pub mode: Option<goat2_contracts::InputMode>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

/// `thread.read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadReadArgs {
    pub thread_id: ThreadId,
    /// Read items with seq below this; omit for the latest.
    #[serde(default)]
    pub before: Option<u64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `thread.list`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadListArgs {
    #[serde(default)]
    pub include_finished: Option<bool>,
}

/// `thread.wait`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadWaitArgs {
    pub thread_id: ThreadId,
    /// At most 60 000.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `thread.stop`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStopArgs {
    pub thread_id: ThreadId,
}

/// `thread.report_result` (worker threads; becomes the parent's `child.reported`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportResultArgs {
    pub outcome: ReportOutcome,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Succeeded,
    Failed,
    Blocked,
    Cancelled,
}

/// `user.send` / `goat_send_to_user`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserSendArgs {
    pub kind: goat2_contracts::NotifyKind,
    pub text: String,
}

/// `request.ask` / `goat_ask`: a question, an approval, or a decision with options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestAskArgs {
    pub kind: AskKind,
    /// Shown in the inbox, at most 200 characters (longer text is cut).
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
    /// Required for `decision`: the choices a person picks from.
    #[serde(default)]
    pub options: Vec<DecisionOption>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskKind {
    Question,
    Approval,
    Decision,
}

pub use goat2_contracts::DecisionOption;

/// What the MCP module needs from the host. The MCP module owns the registry, `goat_describe`,
/// argument decoding, `clientRequestId` reservation and the HTTP/auth layer; the host owns the
/// effects. Every method returns the v1 three-shape envelope.
#[async_trait]
pub trait McpHost: Send + Sync + 'static {
    /// Resolve a bearer token. `None` = unknown or revoked token (HTTP 401).
    fn grant(&self, token: &str) -> Option<McpGrant>;
    /// The caller for a grant: the thread's active run now. Refuses (no effect) when no run is
    /// active, or when the process or host generation is old.
    async fn caller(&self, grant: &McpGrant) -> Result<Caller, SurfaceError>;
    async fn thread_start(&self, caller: &Caller, args: ThreadStartArgs) -> SurfaceResult;
    async fn thread_send(&self, caller: &Caller, args: ThreadSendArgs) -> SurfaceResult;
    async fn thread_read(&self, caller: &Caller, args: ThreadReadArgs) -> SurfaceResult;
    async fn thread_list(&self, caller: &Caller, args: ThreadListArgs) -> SurfaceResult;
    async fn thread_wait(&self, caller: &Caller, args: ThreadWaitArgs) -> SurfaceResult;
    async fn thread_stop(&self, caller: &Caller, args: ThreadStopArgs) -> SurfaceResult;
    async fn report_result(&self, caller: &Caller, args: ReportResultArgs) -> SurfaceResult;
    async fn user_send(&self, caller: &Caller, args: UserSendArgs) -> SurfaceResult;
    async fn request_ask(&self, caller: &Caller, args: RequestAskArgs) -> SurfaceResult;
}

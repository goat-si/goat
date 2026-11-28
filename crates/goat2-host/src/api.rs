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
        text: String,
    },
    /// The item finished (its `item.completed` line follows or preceded); drop its buffer.
    TextDone { item_id: ItemId },
    /// The thread's log was replaced or removed.
    Reset { epoch: Epoch, reason: ResetReason },
}

/// Text of an item still streaming, sent whole (offset 0) when a subscriber joins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingItem {
    pub item_id: ItemId,
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
    /// `decision`: the option id the agent recommends. Silence never approves it.
    #[serde(default)]
    pub recommended: Option<String>,
    /// `question` with choices: 1 to 4 questions shown on one card in turn, each with 2 to 4
    /// options (v1 `OrchestrationV2UserInputQuestion`; limits of Claude's AskUserQuestion,
    /// which v1 maps to the same item).
    #[serde(default)]
    pub questions: Vec<goat2_contracts::UserInputQuestion>,
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

/// `bot.notes_read` / `goat_bot_notes_read`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotNotesReadArgs {
    /// Words to match older notes against (the newest notes always show).
    #[serde(default)]
    pub query: Option<String>,
}

/// `bot.notes_change` / `goat_bot_notes_change`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotNotesChangeArgs {
    /// The note, one line, at most 500 characters (longer is cut).
    pub note: String,
    /// The text of the earlier note this one replaces.
    #[serde(default)]
    pub replaces: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
}

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
    /// Open decisions and questions of the caller and its workers (`decision.list`).
    async fn decision_list(
        &self,
        caller: &Caller,
        args: crate::bot::decisions::DecisionListArgs,
    ) -> SurfaceResult {
        let _ = (caller, args);
        SurfaceResult::err(
            ErrorCode::Unavailable,
            "not_supported",
            "no decisions here",
            false,
        )
    }
    /// One open decision (`decision.read`).
    async fn decision_read(
        &self,
        caller: &Caller,
        args: crate::bot::decisions::DecisionReadArgs,
    ) -> SurfaceResult {
        let _ = (caller, args);
        SurfaceResult::err(
            ErrorCode::Unavailable,
            "not_supported",
            "no decisions here",
            false,
        )
    }
    /// Answer a worker's decision or question (`decision.answer`).
    async fn decision_answer(
        &self,
        caller: &Caller,
        args: goat2_contracts::DecisionAnswerInput,
    ) -> SurfaceResult {
        let _ = (caller, args);
        SurfaceResult::err(
            ErrorCode::Unavailable,
            "not_supported",
            "no decisions here",
            false,
        )
    }
    /// A bot reads its notes.
    async fn bot_notes_read(&self, caller: &Caller, args: BotNotesReadArgs) -> SurfaceResult {
        let _ = (caller, args);
        SurfaceResult::err(
            ErrorCode::Unavailable,
            "not_supported",
            "no bot notes here",
            false,
        )
    }
    /// A bot saves or corrects a note.
    async fn bot_notes_change(&self, caller: &Caller, args: BotNotesChangeArgs) -> SurfaceResult {
        let _ = (caller, args);
        SurfaceResult::err(
            ErrorCode::Unavailable,
            "not_supported",
            "no bot notes here",
            false,
        )
    }
}

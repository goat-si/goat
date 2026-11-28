//! Engine seam. The host drives every engine through [EngineFactory] and [EngineSession].
//!
//! Part 1 has one real driver, Codex (`goat2-engine-codex`, lane B). Until that crate exposes
//! its driver, [codex::CodexFactory] reports the engine as unavailable instead of pretending to
//! run. [fake::FakeEngine] is a scripted engine for tests and for UI work without Codex.
//!
//! Driver results follow `structure/30_wire.md`: a steer or turn start answers
//! `Accepted | Declined | RefusedUnowned | Unknown`, which the host records as `input.delivered`.

pub mod codex;
pub mod fake;

use async_trait::async_trait;
use goat2_contracts::{
    ChatAttachment, EngineConfig, EngineItemLocator, EngineRef, InputId, ItemId, RequestKind,
    ThreadId, TurnItem,
};
use tokio::sync::mpsc;

/// Where the engine reaches the GOAT MCP server for this thread and process generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpEndpoint {
    /// `http://127.0.0.1:<port>/mcp`
    pub url: String,
    /// Bearer token bound to (thread, process generation, host generation).
    pub bearer_token: String,
}

/// Everything a driver needs to start or resume one thread's engine process.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub thread_id: ThreadId,
    pub engine: EngineConfig,
    /// Last seen engine session pointer; resume it when present.
    pub resume: Option<EngineRef>,
    pub mcp: McpEndpoint,
    /// Host generation (bumped on every host start).
    pub host_generation: u64,
    /// Process generation for this thread (bumped on every engine start or resume).
    pub process_generation: u64,
}

/// One input handed to the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineInput {
    pub input_id: InputId,
    pub text: String,
    pub attachments: Vec<ChatAttachment>,
}

/// Per-turn engine settings, read from the card when the run starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSettings {
    pub model: String,
    pub runtime_mode: String,
}

/// Answer to a turn start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStartResult {
    /// The engine accepted the turn (Codex `turn/start` response).
    Accepted { turn_id: String },
    /// Refused before anything ran, such as a start onto a native turn GOAT never owned
    /// (v1 `CodexTurnStartGuard.ts:113-172`). Fails closed: nothing is re-sent.
    RefusedUnowned { reason: String },
    /// Refused before anything ran for another stated reason.
    Declined { reason: String },
    /// No answer; the turn may or may not have reached the engine.
    Unknown { reason: String },
}

/// Answer to a steer into the running turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SteerResult {
    Accepted,
    /// The engine declined after admission; the host re-queues the input as a followup with
    /// the same inputId (v1 `EffectWorker.ts:310-360`).
    Declined {
        reason: String,
    },
    /// The running turn is not one GOAT owns; fails closed.
    RefusedUnowned {
        reason: String,
    },
    Unknown {
        reason: String,
    },
}

/// How a turn ended, as the engine reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnOutcome {
    Done,
    Failed { reason: String },
    Interrupted,
}

/// Decision for an engine request (approval or question).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestAnswer {
    pub outcome: goat2_contracts::RequestOutcome,
    pub text: Option<String>,
    pub answers: Option<serde_json::Map<String, serde_json::Value>>,
}

/// Events from a running engine process, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    /// Streaming text for an unfinished item. Never stored.
    TextDelta {
        turn_id: String,
        item_id: ItemId,
        text: String,
    },
    /// A finished item.
    ItemCompleted {
        turn_id: String,
        item: Box<TurnItem>,
        locator: Option<EngineItemLocator>,
    },
    /// The engine needs a person (approval, question, sign-in). `key` is the driver's own
    /// handle used to answer it.
    RequestOpened {
        turn_id: String,
        key: String,
        item_id: Option<ItemId>,
        kind: RequestKind,
        summary: String,
    },
    /// The engine resolved or withdrew a request by itself.
    RequestClosed { key: String },
    TurnFinished {
        turn_id: String,
        outcome: TurnOutcome,
    },
    /// The process ended. Nothing more follows.
    Exited { reason: String },
}

/// Engine error outside turn results (start, resume, transport).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    #[error("engine unavailable: {0}")]
    Unavailable(String),
    #[error("engine start failed: {0}")]
    StartFailed(String),
    #[error("engine transport failed: {0}")]
    Transport(String),
}

/// A started engine process for one thread.
pub struct EngineHandle {
    pub session: Box<dyn EngineSession>,
    pub events: mpsc::UnboundedReceiver<EngineEvent>,
    /// The engine's session pointer (Codex threadId), written to the card as `engineRef`.
    pub engine_ref: EngineRef,
}

impl std::fmt::Debug for EngineHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineHandle")
            .field("engine_ref", &self.engine_ref)
            .finish_non_exhaustive()
    }
}

/// Starts engine processes. One process per thread.
#[async_trait]
pub trait EngineFactory: Send + Sync + 'static {
    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError>;
}

/// Controls one engine process.
#[async_trait]
pub trait EngineSession: Send + Sync {
    /// Start a turn. `settings` carries the thread's current model and runtime mode, so a
    /// `change_thread` takes effect from the next run (Codex accepts both per turn).
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult;
    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult;
    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError>;
    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError>;
    /// Resident memory of the engine's whole process group, when the driver can measure it
    /// (lane B `ChildProcess::group_rss_bytes()`). Sampled by the host's memory policy.
    fn group_rss_bytes(&self) -> Option<u64> {
        None
    }
    /// Stop the process group (lane B `kill_group()`). Idempotent.
    async fn shutdown(&self);
}

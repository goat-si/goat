//! The engine seam shared by the host and every engine driver.
//!
//! `goat2-host` drives engines only through [EngineFactory] and [EngineSession]; drivers
//! (`goat2-engine-codex` in Part 1, Claude and ACP in Part 2) implement them. Trait and types
//! only, so drivers never depend on the host (`structure/40_deps.md`). Owner: lane E.
//!
//! Driver results follow `structure/30_wire.md`: a steer or turn start answers
//! `Accepted | Declined | RefusedUnowned | Unknown`, which the host records as `input.delivered`.

use async_trait::async_trait;
use std::collections::BTreeMap;
use std::path::PathBuf;

use goat2_contracts::{
    ChatAttachment, EngineConfig, EngineItemLocator, EngineRef, InputId, ItemId,
    ProviderCapabilities, ProviderProbeResult, RequestKind, ThreadId, TurnItem, TurnItemStatus,
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
    /// Text GOAT adds to the engine's own instructions (bot brief, GOAT rules). None = nothing.
    pub instructions: Option<Instructions>,
    /// How to launch the engine binary. None = the driver's default (its CLI on PATH).
    pub launch: Option<LaunchSpec>,
}

/// Instructions GOAT injects. Each driver maps them to its engine's mechanism (Claude
/// `--append-system-prompt`, ACP `session/new` `systemPrompt {mode: append}`, Codex
/// developer instructions).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Instructions {
    /// Appended to the engine's system prompt.
    pub append_system_prompt: Option<String>,
    /// Put before the first user message of a new session, for engines without a system slot.
    pub first_message_preamble: Option<String>,
}

/// Executable, arguments and environment for one engine process (v1 provider settings
/// `binaryPath`, `launchArgs`, instance env; ACP registry commands per runtime mode).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchSpec {
    /// None = the driver's default binary name, looked up on PATH.
    pub binary: Option<PathBuf>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
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
    /// v1 `ModelSelection` (instance, model, options).
    pub model_selection: goat2_contracts::ModelSelection,
    pub runtime_mode: goat2_contracts::RuntimeMode,
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

/// How an accepted steer settled (v1 `steer.updated` status `completed | cancelled`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SteerStatus {
    /// The engine read the steer into the turn.
    Completed,
    /// Accepted earlier but never ran: cancelled, discarded or refused by the engine, or left
    /// unread when the turn ended.
    Cancelled { reason: String },
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
        /// The waiting TurnItem v1 emits for this request (`approval_request` with requestKind,
        /// prompt, reason, options; `user_input_request` with questions), so the UI can render
        /// the choices (v1 `CodexAdapterV2.ts:3576-3777`). The host records it in the timeline.
        item: Option<Box<TurnItem>>,
    },
    /// The engine resolved or withdrew a request by itself.
    RequestClosed { key: String },
    /// The engine needs the person to sign in (Antigravity authorization URL, ACP authenticate,
    /// Claude "not logged in"). The host records it as `request.opened` kind `signin` on the run
    /// named by `turn_id` when there is one.
    AuthRequired {
        /// Engine handle answered through `answer_request` with Accept or Decline when the
        /// person resolves sign-in (v1 ACP URL elicitation: provider-acp/src/server/adapter.ts:5329-5362).
        /// Unique per engine request within a session: the host answers each key at most once,
        /// gives a key at most one sign-in request, and ignores later events naming a key it
        /// already answered.
        key: Option<String>,
        turn_id: Option<String>,
        url: Option<String>,
        message: String,
    },
    /// Cumulative and last-turn usage reported by the engine. Cost is present only when
    /// reported by the engine; the host never estimates it.
    TokenUsage {
        turn_id: Option<String>,
        usage: goat2_contracts::ThreadTokenUsageSnapshot,
    },
    /// Progress of an engine-native subagent (Claude `task_*`, ACP `subagent_update`). Not stored;
    /// the finished subagent arrives as `ItemCompleted` with `TurnItemBody::Subagent`.
    SubagentUpdate {
        turn_id: Option<String>,
        subagent_id: String,
        /// v1 subagent status values.
        status: TurnItemStatus,
        title: Option<String>,
        progress: Option<String>,
    },
    /// A steer the driver already answered `Accepted` settled later (v1 provider event
    /// `steer.updated`, `ProviderAdapter.ts:149-157`; Claude `command_lifecycle`, Pi). An
    /// accepted steer is v1 `pending` until the engine reads it. Not stored as such; the host
    /// decides what a cancelled steer means for its inputs.
    ///
    /// Contract: a driver whose engine can hold an accepted steer unread (Claude, Pi, OpenCode)
    /// reports `SteerUpdated` for each such steer, `Cancelled` for any left unread, before that
    /// turn's `TurnFinished`. The host reads events in order, so a cancel lands while its run is
    /// still active; one after `TurnFinished` is ignored. An accepted steer with no
    /// `SteerUpdated` counts as `Completed`: engines that take a steer straight into the turn
    /// (Codex; v1 never emits `steer.updated` for it) send nothing.
    SteerUpdated {
        turn_id: String,
        input_ids: Vec<InputId>,
        status: SteerStatus,
    },
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
    /// The driver does not support this operation (see its capabilities).
    #[error("not supported by this engine: {0}")]
    Unsupported(String),
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
    /// v1 capability flags for this driver kind; the host chooses steer vs interrupt-restart and
    /// whether to call [EngineSession::set_config] from them.
    fn capabilities(&self) -> ProviderCapabilities;
    /// Install, version, sign-in state and models, without starting a session. The host probes
    /// every registered provider through this, without knowing the driver crate.
    async fn probe(&self) -> Result<ProviderProbeResult, EngineError> {
        Err(EngineError::Unsupported("probe".into()))
    }
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
    /// Change model or runtime mode inside the running session (Claude `set_model` /
    /// `set_permission_mode`, ACP `session/set_mode` / `set_model`). The host calls it only when
    /// the capabilities allow a switch in session; otherwise settings apply from the next turn.
    async fn set_config(&self, settings: &TurnSettings) -> Result<(), EngineError> {
        let _ = settings;
        Err(EngineError::Unsupported("set_config".into()))
    }
    /// Read one finished item back from the engine's own record (lazy details: tool output,
    /// diffs). The host calls it through a live or resumed session, with the locator recorded on
    /// `item.completed`.
    async fn read_item(&self, locator: &EngineItemLocator) -> Result<TurnItem, EngineError> {
        let _ = locator;
        Err(EngineError::Unsupported("read_item".into()))
    }
    /// Resident memory of the engine's whole process group, when the driver can measure it
    /// (lane B `ChildProcess::group_rss_bytes()`). Sampled by the host's memory policy.
    fn group_rss_bytes(&self) -> Option<u64> {
        None
    }
    /// The engine's process group id, recorded in `host.json` so the next start can kill it
    /// if this host dies.
    fn process_group_id(&self) -> Option<i32> {
        None
    }
    /// Stop the process group (lane B `kill_group()`). Idempotent.
    async fn shutdown(&self);
}

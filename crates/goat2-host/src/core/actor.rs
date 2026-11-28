//! Per-thread actor: the thread's mailbox and lane.
//!
//! One run at a time. Queue state lives in the store's fold (`queuedInputs`, `heldInputs`), so
//! a restart resumes it; the actor keeps only what dies with the process: the engine session,
//! the run slot, the Stop hold and timers.
//!
//! Follow-up semantics follow GOAT v1 (`docs/lanes/PART1.md`, PRD runtime.md):
//! - `steer` into a running turn; a steer the engine declines after admission stays queued and
//!   runs as the next turn with the same inputId (v1 `EffectWorker.ts:310-360`).
//! - `followup` waits for the next turn; `collect` merges inputs within the collect window.
//! - `interrupt` (explicit "stop and send") interrupts the turn and goes first.
//! - Stop interrupts the turn, holds the queue and stops wait-mode children; async children keep
//!   running (v1 `ChildNeedsStop.ts`, `orchestrationV2.ts:3231-3242`). The next user input or
//!   `resume_queue` releases the hold.

use std::sync::Arc;
use std::time::Instant;

use goat2_contracts::limits::CHILD_SUMMARY_MAX_BYTES;
use goat2_contracts::text::clamp_bytes;
use goat2_contracts::{
    AssistantMessagePhase, ChatAttachment, ChildReported, ChildResultStatus, DeliveredAs,
    DeliveryOutcome, EngineTurnRef, FollowUpMode, InputAccepted, InputChanged, InputDelivered,
    InputId, InputMode, InputSource, ItemCompleted, LogEvent, QueuedInput, RequestId, RequestKind,
    RequestOpened, RequestOutcome, RequestResolved, RunAccepted, RunFinished, RunId, RunOutcome,
    RunStarted, ThreadCard, ThreadCursor, ThreadId, TurnItemBody,
};
use tokio::sync::{mpsc, oneshot};

use super::sched::{Priority, RunPermit};
use super::{ChildOutcome, Host};
use crate::api::{Reason, ReportOutcome};
use crate::engine::{
    EngineEvent, EngineHandle, EngineInput, EngineSession, McpEndpoint, RequestAnswer, SessionSpec,
    SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use crate::util::new_id;

/// A new input for a thread.
#[derive(Debug, Clone)]
pub struct NewInput {
    pub from: InputSource,
    pub text: String,
    pub attachments: Vec<ChatAttachment>,
    /// `None` = the thread's follow-up mode.
    pub mode: Option<InputMode>,
    pub client_request_id: String,
}

/// Why an actor refused a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: Reason,
    pub message: String,
}

impl Refusal {
    pub fn new(code: Reason, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub type Reply<T> = oneshot::Sender<Result<T, Refusal>>;

/// Answer to an accepted input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputAck {
    pub input_id: InputId,
    pub run_id: Option<RunId>,
}

/// Queue edits (`input.changed`).
#[derive(Debug, Clone)]
pub enum QueueEdit {
    Edit { input_id: InputId, text: String },
    Cancel { input_id: InputId },
    Reorder { input_ids: Vec<InputId> },
    PromoteToSteer { input_id: InputId },
}

/// A person's answer to an open request.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub request_id: RequestId,
    pub outcome: RequestOutcome,
    pub option_id: Option<String>,
    pub text: Option<String>,
    pub answers: Option<serde_json::Map<String, serde_json::Value>>,
}

pub enum Msg {
    Input(NewInput, Reply<InputAck>),
    /// `hold`: the Stop button (holds the queue). Without hold: `thread.stop` from a parent.
    Stop {
        hold: bool,
        reply: Option<Reply<Option<RunId>>>,
    },
    ResumeQueue(Reply<()>),
    Resolve(Resolution, Reply<()>),
    Queue(QueueEdit, Reply<()>),
    ChildResult {
        outcome: ChildOutcome,
        delivered_in_wait: bool,
    },
    Permit(RunPermit),
    Started {
        pgen: u64,
        result: Result<EngineHandle, String>,
    },
    Engine {
        pgen: u64,
        event: EngineEvent,
    },
    Tick,
    IdleCheck(u64),
    MemoryLimit {
        pgen: u64,
        bytes: u64,
    },
}

impl std::fmt::Debug for Msg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Msg::Input(..) => "input",
            Msg::Stop { .. } => "stop",
            Msg::ResumeQueue(_) => "resume_queue",
            Msg::Resolve(..) => "resolve",
            Msg::Queue(..) => "queue",
            Msg::ChildResult { .. } => "child_result",
            Msg::Permit(_) => "permit",
            Msg::Started { .. } => "started",
            Msg::Engine { .. } => "engine",
            Msg::Tick => "tick",
            Msg::IdleCheck(_) => "idle_check",
            Msg::MemoryLimit { .. } => "memory_limit",
        })
    }
}

enum Phase {
    Idle,
    WaitingPermit,
    Starting(RunPermit),
    Running(ActiveRun),
}

struct ActiveRun {
    run_id: RunId,
    turn_id: String,
    permit: RunPermit,
    /// Set when an engine request id must map back (key -> request).
    engine_requests: Vec<(String, RequestId)>,
    /// `signin` requests opened for this run's turn, closed when the run ends. Answered by the
    /// person, never through the engine, so they are kept apart from `engine_requests`.
    signins: Vec<RequestId>,
}

struct Session {
    pgen: u64,
    session: Arc<dyn EngineSession>,
}

struct Actor {
    host: Host,
    id: ThreadId,
    parent: Option<ThreadId>,
    phase: Phase,
    session: Option<Session>,
    pgen: u64,
    held: bool,
    not_before: Option<Instant>,
    idle_gen: u64,
    /// `signin` requests the engine raised outside any turn, closed when the session ends.
    session_signins: Vec<RequestId>,
    /// Turns accepted in the current engine session and their runs (newest last, at most
    /// [TURN_RUNS_KEPT]): items a driver delivers after their turn ended (background
    /// subagents) go to their origin run.
    turn_runs: std::collections::VecDeque<(String, RunId)>,
    /// Engine-native subagents still running in this session (non-terminal SubagentUpdate):
    /// the engine is not idle-stopped while any runs (v1 keeps background subagents alive).
    live_subagents: std::collections::HashSet<String>,
    tx: mpsc::UnboundedSender<Msg>,
}

pub(crate) fn spawn(host: Host, card: ThreadCard) -> mpsc::UnboundedSender<Msg> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let parent = card.parent.as_ref().map(|p| p.thread_id.clone());
    host.runtime_update(&card.id, |rt| {
        rt.kind = Some(card.kind);
        rt.parent = parent.clone();
    });
    let tracker = host.clone();
    let mut actor = Actor {
        host,
        id: card.id.clone(),
        parent,
        phase: Phase::Idle,
        session: None,
        pgen: 0,
        held: false,
        not_before: None,
        idle_gen: 0,
        session_signins: Vec::new(),
        turn_runs: std::collections::VecDeque::new(),
        live_subagents: std::collections::HashSet::new(),
        tx: tx.clone(),
    };
    let task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let started = Instant::now();
            let label = format!("{msg:?}");
            actor.handle(msg).await;
            actor.sync_runtime();
            let took = started.elapsed();
            if took >= crate::stall::STALL_THRESHOLD {
                actor.host.inner.stall.record(
                    "actor",
                    took.as_millis() as u64,
                    serde_json::json!({ "thread": actor.id, "msg": label }),
                );
            }
        }
    });
    tracker.track(&task);
    tx
}

fn input_mode_for(mode: FollowUpMode) -> InputMode {
    match mode {
        FollowUpMode::Steer => InputMode::Steer,
        FollowUpMode::Followup => InputMode::Followup,
        FollowUpMode::Collect => InputMode::Collect,
    }
}

fn to_engine(q: &QueuedInput) -> EngineInput {
    EngineInput {
        input_id: q.input_id.clone(),
        text: q.text.clone(),
        attachments: q.attachments.clone(),
    }
}

impl Actor {
    fn store_err(&self, err: impl std::fmt::Display) -> Refusal {
        tracing::error!(thread = %self.id, %err, "store write failed");
        Refusal::new(Reason::Internal, err.to_string())
    }

    fn append(&self, events: Vec<LogEvent>) -> Option<crate::store::Appended> {
        match self.host.append(&self.id, events) {
            Ok(a) => Some(a),
            Err(err) => {
                tracing::error!(thread = %self.id, %err, "append failed");
                None
            }
        }
    }

    fn active_run_id(&self) -> Option<RunId> {
        match &self.phase {
            Phase::Running(run) => Some(run.run_id.clone()),
            _ => None,
        }
    }

    /// Queued inputs not carried by the active run, in order.
    fn pending(&self) -> Vec<QueuedInput> {
        let Some(fold) = self.host.inner.store.fold(&self.id) else {
            return Vec::new();
        };
        fold.queued_inputs
            .into_iter()
            .filter(|q| !fold.active_run_input_ids.contains(&q.input_id))
            .collect()
    }

    fn resend_blocked(&self) -> bool {
        self.host.inner.store.fold(&self.id).is_some_and(|f| {
            !f.held_inputs.is_empty()
                || f.open_requests
                    .iter()
                    .any(|r| r.kind == RequestKind::Resend)
        })
    }

    fn sync_runtime(&self) {
        let busy = !matches!(self.phase, Phase::Idle) || !self.pending().is_empty();
        let active = self.active_run_id();
        let run_slot = match &self.phase {
            Phase::Running(run) => Some(run.permit.slot()),
            _ => None,
        };
        let alive = self.session.is_some();
        let pgen = self.pgen;
        self.host.runtime_update(&self.id, |rt| {
            rt.busy = busy;
            if rt.active_run != active {
                rt.report = None;
                rt.notified.clear();
                rt.last_answer.clear();
            }
            rt.active_run = active;
            rt.run_slot = run_slot;
            rt.session_alive = alive;
            rt.process_generation = pgen;
        });
    }

    async fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Input(input, reply) => {
                let result = self.accept(input).await;
                let _ = reply.send(result);
            }
            Msg::Stop { hold, reply } => {
                let stopped = self.stop(hold).await;
                if let Some(reply) = reply {
                    let _ = reply.send(Ok(stopped));
                }
            }
            Msg::ResumeQueue(reply) => {
                self.held = false;
                let _ = reply.send(Ok(()));
                self.maybe_start();
            }
            Msg::Resolve(resolution, reply) => {
                let result = self.resolve(resolution).await;
                let _ = reply.send(result);
                self.maybe_start();
            }
            Msg::Queue(edit, reply) => {
                let result = self.edit_queue(edit).await;
                let _ = reply.send(result);
                self.maybe_start();
            }
            Msg::ChildResult {
                outcome,
                delivered_in_wait,
            } => self.child_result(outcome, delivered_in_wait).await,
            Msg::Permit(permit) => self.on_permit(permit).await,
            Msg::Started { pgen, result } => self.on_started(pgen, result).await,
            Msg::Engine { pgen, event } => {
                if pgen == self.pgen {
                    self.on_engine(event).await;
                }
            }
            Msg::Tick => self.maybe_start(),
            Msg::IdleCheck(gen_) => {
                if gen_ == self.idle_gen
                    && matches!(self.phase, Phase::Idle)
                    && self.session.is_some()
                    && self.live_subagents.is_empty()
                {
                    self.stop_session("idle").await;
                }
            }
            Msg::MemoryLimit { pgen, bytes } => {
                if pgen == self.pgen && self.session.is_some() {
                    self.host.inner.stall.note(
                        "memory_limit",
                        serde_json::json!({ "thread": self.id, "rssBytes": bytes }),
                    );
                    self.stop_session("memory_limit").await;
                    if matches!(self.phase, Phase::Running(_)) {
                        self.finish_run(RunOutcome::Failed, Some("memory_limit".to_owned()))
                            .await;
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ inputs

    async fn accept(&mut self, input: NewInput) -> Result<InputAck, Refusal> {
        self.accept_with(input, Vec::new()).await
    }

    /// Accept an input, writing `pre` in the same append (a child's `child.reported` and its
    /// wake input land together, so a crash cannot keep one without the other).
    async fn accept_with(
        &mut self,
        input: NewInput,
        pre: Vec<LogEvent>,
    ) -> Result<InputAck, Refusal> {
        let card = self
            .host
            .inner
            .store
            .card(&self.id)
            .ok_or_else(|| Refusal::new(Reason::ThreadNotFound, "thread not found"))?;
        let mode = input
            .mode
            .unwrap_or_else(|| input_mode_for(card.follow_up_mode));
        // A person's input or a parent's `thread.send` releases a Stop hold (v1: the next send
        // releases it); child results and answers do not.
        if matches!(input.from, InputSource::User | InputSource::System) {
            self.held = false;
        }
        let input_id = InputId::new(new_id("in"));
        let accepted = InputAccepted {
            input_id: input_id.clone(),
            from: input.from.clone(),
            mode,
            text: input.text.clone(),
            attachments: input.attachments.clone(),
            client_request_id: input.client_request_id,
        };
        let mut events = pre;
        events.push(LogEvent::InputAccepted(accepted));
        self.host
            .append(&self.id, events)
            .map_err(|e| self.store_err(e))?;
        self.host.runtime_update(&self.id, |rt| rt.busy = true);
        let queued = QueuedInput {
            input_id: input_id.clone(),
            text: input.text,
            mode,
            source: input.from.clone(),
            attachments: input.attachments,
        };
        let mut run_id = None;
        match mode {
            InputMode::Steer => {
                run_id = self.steer_now(&queued).await?;
            }
            InputMode::Interrupt => {
                if let Phase::Running(run) = &self.phase {
                    let (turn, run_id) = (run.turn_id.clone(), run.run_id.clone());
                    self.stop_wait_children(&run_id);
                    self.interrupt_or_fence(&turn).await;
                }
            }
            InputMode::Collect => {
                self.not_before = Some(Instant::now() + self.host.inner.opts.collect_window);
                self.arm_tick();
            }
            InputMode::Followup => {}
        }
        if matches!(input.from, InputSource::Child { .. }) && matches!(self.phase, Phase::Idle) {
            let until = Instant::now() + self.host.inner.opts.child_coalesce;
            self.not_before = Some(self.not_before.map_or(until, |t| t.max(until)));
            self.arm_tick();
        }
        self.maybe_start();
        Ok(InputAck { input_id, run_id })
    }

    /// Steer a queued input into the running turn. `Ok(Some(run))` = joined that run;
    /// `Ok(None)` = stays queued for the next turn (not running, or declined after admission,
    /// v1 `EffectWorker.ts:310-360`); `Err` = refused, fails closed (v1
    /// `CodexTurnStartGuard.ts:113-172`).
    async fn steer_now(&mut self, q: &QueuedInput) -> Result<Option<RunId>, Refusal> {
        let Phase::Running(run) = &self.phase else {
            return Ok(None); // Not running: it starts the next turn.
        };
        if self.resend_blocked() || run.turn_id.is_empty() {
            return Ok(None);
        }
        let (run_id, turn_id) = (run.run_id.clone(), run.turn_id.clone());
        let Some(session) = self.session.as_ref().map(|s| s.session.clone()) else {
            return Ok(None);
        };
        let delivered = |outcome| {
            LogEvent::InputDelivered(InputDelivered {
                input_id: q.input_id.clone(),
                run_id: run_id.clone(),
                delivered_as: DeliveredAs::Steer,
                outcome,
            })
        };
        match session.steer(&turn_id, vec![to_engine(q)]).await {
            SteerResult::Accepted => {
                self.append(vec![delivered(DeliveryOutcome::Accepted)]);
                Ok(Some(run_id))
            }
            SteerResult::Declined { .. } => {
                self.append(vec![delivered(DeliveryOutcome::Declined)]);
                Ok(None)
            }
            SteerResult::RefusedUnowned { reason } => {
                // Fails closed: the input leaves the queue and is never retried.
                self.append(vec![delivered(DeliveryOutcome::Refused)]);
                Err(Refusal::new(Reason::SteerRefused, reason))
            }
            SteerResult::Unknown { .. } => {
                // Maybe delivered: held for a person to resend or drop, never re-sent by itself.
                let request_id = crate::store::resend_request_id(&run_id);
                let mut events = vec![delivered(DeliveryOutcome::Unknown)];
                if !self.is_open(&request_id) {
                    events.push(LogEvent::RequestOpened(RequestOpened {
                        request_id,
                        run_id: Some(run_id.clone()),
                        item_id: None,
                        kind: RequestKind::Resend,
                        summary: "Not sure a message reached the agent. Resend or drop it?"
                            .to_owned(),
                        context: None,
                        options: None,
                        recommended: None,
                    }));
                }
                self.append(events);
                Ok(None)
            }
        }
    }

    /// Interrupt the running turn; if the engine cannot, stop its process so the old turn
    /// cannot keep running, and end the run.
    async fn interrupt_or_fence(&mut self, turn_id: &str) {
        let ok = match &self.session {
            Some(s) => s.session.interrupt(turn_id).await.is_ok(),
            None => false,
        };
        if !ok {
            self.stop_session("interrupt failed").await;
            self.finish_run(
                RunOutcome::Interrupted,
                Some("interrupt failed; engine stopped".to_owned()),
            )
            .await;
        }
    }

    // ------------------------------------------------------------------ scheduling

    fn arm_tick(&self) {
        if let Some(at) = self.not_before {
            let tx = self.tx.clone();
            tokio::spawn(async move {
                tokio::time::sleep_until(at.into()).await;
                let _ = tx.send(Msg::Tick);
            });
        }
    }

    fn maybe_start(&mut self) {
        if !matches!(self.phase, Phase::Idle) || self.held || self.resend_blocked() {
            return;
        }
        let pending = self.pending();
        let Some(head) = pending.first() else {
            return;
        };
        if let Some(at) = self.not_before {
            if Instant::now() < at {
                return;
            }
            self.not_before = None;
        }
        let priority = match head.source {
            InputSource::User => Priority::Human,
            InputSource::Child { .. } => Priority::Child,
            InputSource::System => Priority::Background,
        };
        self.phase = Phase::WaitingPermit;
        let rx = self.host.inner.sched.acquire(priority);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            if let Ok(permit) = rx.await {
                let _ = tx.send(Msg::Permit(permit));
            }
        });
    }

    async fn on_permit(&mut self, permit: RunPermit) {
        if !matches!(self.phase, Phase::WaitingPermit) {
            return;
        }
        if self.held || self.resend_blocked() || self.pending().is_empty() {
            self.phase = Phase::Idle;
            return;
        }
        if self.session.is_some() {
            self.begin_run(permit, None).await;
            return;
        }
        let Some(card) = self.host.inner.store.card(&self.id) else {
            self.phase = Phase::Idle;
            return;
        };
        self.pgen += 1;
        let pgen = self.pgen;
        let token = self.host.issue_token(&self.id, pgen);
        let spec = SessionSpec {
            thread_id: self.id.clone(),
            engine: card.engine.clone(),
            resume: card.engine_ref.clone(),
            mcp: McpEndpoint {
                url: self.host.inner.mcp_url.get().cloned().unwrap_or_default(),
                bearer_token: token,
            },
            host_generation: self.host.inner.opts.host_generation,
            process_generation: pgen,
            // Driver defaults: bot instructions and launch overrides come with Part 2 bots.
            instructions: None,
            launch: None,
        };
        self.phase = Phase::Starting(permit);
        let host = self.host.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _slot = host.inner.sched.start_slot().await;
            let result = host
                .inner
                .engine
                .start(spec)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(Msg::Started { pgen, result });
        });
    }

    async fn on_started(&mut self, pgen: u64, result: Result<EngineHandle, String>) {
        if pgen != self.pgen {
            if let Ok(handle) = result {
                handle.session.shutdown().await;
            }
            return;
        }
        let Phase::Starting(permit) = std::mem::replace(&mut self.phase, Phase::Idle) else {
            if let Ok(handle) = result {
                handle.session.shutdown().await;
            }
            return;
        };
        match result {
            Ok(handle) => {
                let session: Arc<dyn EngineSession> = Arc::from(handle.session);
                self.host
                    .inner
                    .sessions
                    .lock()
                    .expect("sessions")
                    .insert(self.id.clone(), (pgen, session.clone()));
                self.host.engine_groups_changed();
                self.session = Some(Session { pgen, session });
                let mut events = handle.events;
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    let mut exited = false;
                    while let Some(event) = events.recv().await {
                        exited |= matches!(event, EngineEvent::Exited { .. });
                        if tx.send(Msg::Engine { pgen, event }).is_err() {
                            return;
                        }
                    }
                    if !exited {
                        let _ = tx.send(Msg::Engine {
                            pgen,
                            event: EngineEvent::Exited {
                                reason: "engine event stream closed".to_owned(),
                            },
                        });
                    }
                });
                self.begin_run(permit, Some(handle.engine_ref)).await;
            }
            Err(reason) => {
                self.host.revoke_tokens(&self.id);
                self.fail_before_send(permit, &format!("engine start failed: {reason}"));
            }
        }
    }

    /// The engine never got the inputs: record a failed run and hold the queue so it is not
    /// retried in a loop. The next user input or `resume_queue` releases it.
    fn fail_before_send(&mut self, permit: RunPermit, reason: &str) {
        let batch = take_batch(&self.pending());
        let run_id = RunId::new(new_id("run"));
        self.append(vec![
            LogEvent::RunStarted(RunStarted {
                run_id: run_id.clone(),
                input_ids: batch.iter().map(|q| q.input_id.clone()).collect(),
                generation: self.host.inner.opts.host_generation,
                engine_ref: None,
            }),
            LogEvent::RunFinished(RunFinished {
                run_id,
                outcome: RunOutcome::Failed,
                reason: Some(reason.to_owned()),
            }),
        ]);
        self.held = true;
        drop(permit);
        self.phase = Phase::Idle;
    }

    async fn begin_run(
        &mut self,
        permit: RunPermit,
        engine_ref: Option<goat2_contracts::EngineRef>,
    ) {
        let batch = take_batch(&self.pending());
        if batch.is_empty() || self.held {
            self.phase = Phase::Idle;
            return;
        }
        let Some(card) = self.host.inner.store.card(&self.id) else {
            self.phase = Phase::Idle;
            return;
        };
        let run_id = RunId::new(new_id("run"));
        let input_ids: Vec<InputId> = batch.iter().map(|q| q.input_id.clone()).collect();
        // Send boundary: on disk before anything reaches the engine.
        if self
            .host
            .append_durable(
                &self.id,
                vec![LogEvent::RunStarted(RunStarted {
                    run_id: run_id.clone(),
                    input_ids: input_ids.clone(),
                    generation: self.host.inner.opts.host_generation,
                    engine_ref,
                })],
            )
            .is_err()
        {
            self.phase = Phase::Idle;
            return;
        }
        let Some(session) = self.session.as_ref().map(|s| s.session.clone()) else {
            self.phase = Phase::Idle;
            return;
        };
        let settings = TurnSettings {
            model_selection: card.engine.model_selection.clone(),
            runtime_mode: card.engine.runtime_mode,
        };
        let inputs: Vec<EngineInput> = batch.iter().map(to_engine).collect();
        let delivered = |outcome| {
            input_ids
                .iter()
                .map(|id| {
                    LogEvent::InputDelivered(InputDelivered {
                        input_id: id.clone(),
                        run_id: run_id.clone(),
                        delivered_as: DeliveredAs::Turn,
                        outcome,
                    })
                })
                .collect::<Vec<_>>()
        };
        match session.start_turn(inputs, &settings).await {
            TurnStartResult::Accepted { turn_id } => {
                let mut events = vec![LogEvent::RunAccepted(RunAccepted {
                    run_id: run_id.clone(),
                    engine_turn_ref: EngineTurnRef {
                        driver: goat2_contracts::EngineDriver::Codex,
                        id: turn_id.clone(),
                    },
                })];
                events.extend(delivered(DeliveryOutcome::Accepted));
                self.append(events);
                if self.turn_runs.len() >= TURN_RUNS_KEPT {
                    self.turn_runs.pop_front();
                }
                self.turn_runs.push_back((turn_id.clone(), run_id.clone()));
                self.phase = Phase::Running(ActiveRun {
                    run_id,
                    turn_id,
                    permit,
                    engine_requests: Vec::new(),
                    signins: Vec::new(),
                });
            }
            TurnStartResult::RefusedUnowned { reason } => {
                // A start onto a native turn GOAT never owned fails closed: the inputs leave the
                // queue and are never retried (v1 CodexTurnStartGuard.ts:113-172).
                let run_id_for_report = run_id.clone();
                let mut events = delivered(DeliveryOutcome::Refused);
                events.push(LogEvent::RunFinished(RunFinished {
                    run_id,
                    outcome: RunOutcome::Failed,
                    reason: Some(reason),
                }));
                self.append(events);
                drop(permit);
                self.phase = Phase::Idle;
                self.after_run(Some(run_id_for_report), ChildResultStatus::Failed)
                    .await;
                self.maybe_start();
            }
            TurnStartResult::Declined { reason } => {
                // Declined before anything ran: inputs stay queued; hold so they are not retried
                // in a loop. The next send or resume_queue releases it.
                let run_id_for_report = run_id.clone();
                let mut events = delivered(DeliveryOutcome::Declined);
                events.push(LogEvent::RunFinished(RunFinished {
                    run_id,
                    outcome: RunOutcome::Failed,
                    reason: Some(reason),
                }));
                self.append(events);
                self.held = true;
                drop(permit);
                self.phase = Phase::Idle;
                self.after_run(Some(run_id_for_report), ChildResultStatus::Failed)
                    .await;
            }
            TurnStartResult::Unknown { reason } => {
                self.phase = Phase::Running(ActiveRun {
                    run_id,
                    turn_id: String::new(),
                    permit,
                    engine_requests: Vec::new(),
                    signins: Vec::new(),
                });
                self.finish_run(RunOutcome::Unknown, Some(reason)).await;
            }
        }
    }

    // ------------------------------------------------------------------ engine events

    async fn on_engine(&mut self, event: EngineEvent) {
        match event {
            EngineEvent::TextDelta {
                turn_id,
                item_id,
                text,
            } => {
                // Live text only for the running turn; a late item arrives whole.
                if matches!(&self.phase, Phase::Running(run) if run.turn_id == turn_id) {
                    self.host.stream_text(&self.id, &item_id, &text);
                }
            }
            EngineEvent::ItemCompleted {
                turn_id,
                item,
                locator,
            } => {
                // The run of the item's turn: the active run, or the earlier run of this session
                // a late item (a background subagent finishing after its turn) belongs to. It is
                // appended after that run's run.finished; the run is not reopened.
                let active = matches!(&self.phase, Phase::Running(run) if run.turn_id == turn_id);
                let run_id = if active {
                    self.active_run_id()
                } else {
                    self.turn_runs
                        .iter()
                        .rev()
                        .find(|(t, _)| *t == turn_id)
                        .map(|(_, r)| r.clone())
                };
                let Some(run_id) = run_id else {
                    tracing::warn!(thread = %self.id, "item for a turn this session did not start: dropped");
                    return;
                };
                let mut item = *item;
                item.run_id = Some(run_id.clone());
                item.thread_id = self.id.clone();
                let item_id = item.id.clone();
                if let TurnItemBody::Subagent { subagent_id, .. } = &item.body
                    && is_terminal(item.status)
                    && self.live_subagents.remove(subagent_id)
                    && self.live_subagents.is_empty()
                    && matches!(self.phase, Phase::Idle)
                {
                    self.arm_idle();
                }
                if active
                    && let TurnItemBody::AssistantMessage { phase, text, .. } = &item.body
                    && !matches!(phase, Some(AssistantMessagePhase::Commentary))
                {
                    let text = text.clone();
                    self.host
                        .runtime_update(&self.id, |rt| rt.last_answer = text);
                }
                self.append(vec![LogEvent::ItemCompleted(ItemCompleted {
                    run_id,
                    item,
                    engine_locator: locator,
                    blob: None,
                })]);
                self.host.stream_done(&self.id, &item_id);
            }
            EngineEvent::RequestOpened {
                key,
                item_id,
                kind,
                summary,
                item,
                ..
            } => {
                let Phase::Running(run) = &mut self.phase else {
                    return;
                };
                let request_id = RequestId::new(new_id("req"));
                run.engine_requests.push((key, request_id.clone()));
                let run_id = run.run_id.clone();
                let item_id = item
                    .as_ref()
                    .map(|i| i.id.clone())
                    .or(item_id)
                    .unwrap_or_else(|| goat2_contracts::ItemId::new(new_id("engine-request")));
                // The waiting item (approval_request / user_input_request) goes into the timeline
                // first, so the UI renders the choices; the request points at it.
                let mut events = Vec::new();
                if let Some(item) = item {
                    let mut item = *item;
                    item.run_id = Some(run_id.clone());
                    item.thread_id = self.id.clone();
                    events.push(LogEvent::ItemCompleted(ItemCompleted {
                        run_id: run_id.clone(),
                        item,
                        engine_locator: None,
                        blob: None,
                    }));
                }
                events.push(LogEvent::RequestOpened(RequestOpened {
                    request_id,
                    run_id: Some(run_id),
                    item_id: Some(item_id),
                    kind,
                    summary: goat2_contracts::text::clamp_chars(
                        &summary,
                        goat2_contracts::limits::NEEDS_YOU_SUMMARY_MAX_CHARS,
                    ),
                    context: None,
                    options: None,
                    recommended: None,
                }));
                self.append(events);
            }
            EngineEvent::RequestClosed { key } => {
                let request = match &mut self.phase {
                    Phase::Running(run) => {
                        let found = run.engine_requests.iter().position(|(k, _)| *k == key);
                        found.map(|i| run.engine_requests.remove(i).1)
                    }
                    _ => None,
                };
                if let Some(request_id) = request
                    && self.is_open(&request_id)
                {
                    self.append(vec![LogEvent::RequestResolved(RequestResolved {
                        request_id,
                        outcome: RequestOutcome::Cancel,
                        option_id: None,
                        text: Some("closed by the engine".to_owned()),
                        answers: None,
                    })]);
                }
            }
            EngineEvent::TurnFinished { turn_id, outcome } => {
                let matches_turn =
                    matches!(&self.phase, Phase::Running(run) if run.turn_id == turn_id);
                if matches_turn {
                    let (outcome, reason) = match outcome {
                        TurnOutcome::Done => (RunOutcome::Completed, None),
                        TurnOutcome::Failed { reason } => (RunOutcome::Failed, Some(reason)),
                        TurnOutcome::Interrupted => (RunOutcome::Interrupted, None),
                    };
                    self.finish_run(outcome, reason).await;
                }
            }
            EngineEvent::AuthRequired {
                turn_id,
                url,
                message,
            } => self.on_auth_required(turn_id, url, message),
            EngineEvent::SubagentUpdate {
                subagent_id,
                status,
                ..
            } => {
                // Progress of an unfinished native subagent: not stored (PRD storage.md: no
                // progress updates in the log). The finished subagent arrives as an item. There
                // is no live wire frame for it yet (structure/30_wire.md). A running one keeps
                // the engine from being idle-stopped.
                tracing::debug!(thread = %self.id, %subagent_id, "subagent progress (not stored)");
                if is_terminal(status) {
                    if self.live_subagents.remove(&subagent_id)
                        && self.live_subagents.is_empty()
                        && matches!(self.phase, Phase::Idle)
                    {
                        self.arm_idle();
                    }
                } else {
                    self.live_subagents.insert(subagent_id);
                }
            }
            EngineEvent::SteerUpdated {
                turn_id, status, ..
            } => {
                // What a cancelled steer does to its inputs (v1 marks the message cancelled; a
                // re-queue as followup like SteerResult::Declined is proposed) is pending the
                // owner's decision; until then the accepted delivery stands, as before.
                tracing::debug!(thread = %self.id, %turn_id, ?status, "steer settled (not acted on yet)");
            }
            EngineEvent::Exited { reason } => {
                self.drop_session();
                if matches!(self.phase, Phase::Running(_)) {
                    self.finish_run(RunOutcome::Failed, Some(format!("engine exited: {reason}")))
                        .await;
                }
            }
        }
    }

    fn is_open(&self, request_id: &RequestId) -> bool {
        self.host
            .inner
            .store
            .fold(&self.id)
            .is_some_and(|f| f.open_requests.iter().any(|r| &r.request_id == request_id))
    }

    /// The engine needs the person to sign in: a `signin` request, answered by the person. A
    /// sign-in naming a turn belongs to that run and only while it runs; one naming a turn that
    /// is no longer running is dropped (the next turn asks again). One without a turn belongs to
    /// the engine session. Each scope keeps at most one open sign-in; a repeat refreshes its link.
    fn on_auth_required(&mut self, turn_id: Option<String>, url: Option<String>, message: String) {
        let run_id = match (&turn_id, &self.phase) {
            (Some(turn), Phase::Running(run)) if run.turn_id == *turn => Some(run.run_id.clone()),
            (Some(_), _) => {
                tracing::debug!(thread = %self.id, "sign-in for a turn that is not running: dropped");
                return;
            }
            (None, _) => None,
        };
        let scope: &[RequestId] = match (&run_id, &self.phase) {
            (Some(_), Phase::Running(run)) => &run.signins,
            _ => &self.session_signins,
        };
        let open = scope.iter().find(|id| self.is_open(id)).cloned();
        let request_id = match open {
            Some(request_id) => request_id,
            None => {
                let request_id = RequestId::new(new_id("req"));
                self.append(vec![LogEvent::RequestOpened(RequestOpened {
                    request_id: request_id.clone(),
                    run_id: run_id.clone(),
                    item_id: Some(goat2_contracts::ItemId::new(format!("signin:{request_id}"))),
                    kind: RequestKind::Signin,
                    summary: SIGNIN_SUMMARY.to_owned(),
                    context: None,
                    options: None,
                    recommended: None,
                })]);
                match (&run_id, &mut self.phase) {
                    (Some(_), Phase::Running(run)) => run.signins.push(request_id.clone()),
                    _ => self.session_signins.push(request_id.clone()),
                }
                request_id
            }
        };
        match url.filter(|u| !u.trim().is_empty()) {
            Some(url) => self.host.set_signin_link(crate::core::SigninLink {
                thread_id: self.id.clone(),
                request_id,
                url,
                message,
            }),
            None => self.host.forget_signin_link(&request_id),
        }
    }

    /// Close the still open sign-ins among `ids` with `why`; their links are dropped.
    fn close_signins(&self, ids: &[RequestId], why: &str) -> Vec<LogEvent> {
        let mut events = Vec::new();
        for request_id in ids {
            self.host.forget_signin_link(request_id);
            if self.is_open(request_id) {
                events.push(LogEvent::RequestResolved(RequestResolved {
                    request_id: request_id.clone(),
                    outcome: RequestOutcome::Cancel,
                    option_id: None,
                    text: Some(why.to_owned()),
                    answers: None,
                }));
            }
        }
        events
    }

    /// End the active run: `run.finished`, engine requests closed, checkpoint, child report.
    async fn finish_run(&mut self, outcome: RunOutcome, reason: Option<String>) {
        if !matches!(self.phase, Phase::Running(_)) {
            return;
        }
        // MCP writes for this run commit under the same fence: one in progress finishes first,
        // later ones see the run ended and write nothing.
        let fence = self.host.fence_lock(&self.id);
        let fenced = fence.lock_owned().await;
        let Phase::Running(run) = std::mem::replace(&mut self.phase, Phase::Idle) else {
            return;
        };
        let mut events = Vec::new();
        for (_, request_id) in &run.engine_requests {
            if self.is_open(request_id) {
                events.push(LogEvent::RequestResolved(RequestResolved {
                    request_id: request_id.clone(),
                    outcome: RequestOutcome::Cancel,
                    option_id: None,
                    text: Some("the run ended".to_owned()),
                    answers: None,
                }));
            }
        }
        events.extend(self.close_signins(&run.signins, "the run ended"));
        events.push(LogEvent::RunFinished(RunFinished {
            run_id: run.run_id.clone(),
            outcome,
            reason,
        }));
        if outcome == RunOutcome::Unknown {
            events.push(LogEvent::RequestOpened(RequestOpened {
                request_id: crate::store::resend_request_id(&run.run_id),
                run_id: Some(run.run_id.clone()),
                item_id: None,
                kind: RequestKind::Resend,
                summary: "Not sure the last message reached the agent. Resend or drop it?"
                    .to_owned(),
                context: None,
                options: None,
                recommended: None,
            }));
        }
        self.append(events);
        self.host.runtime_update(&self.id, |rt| {
            rt.active_run = None;
            rt.run_slot = None;
        });
        drop(fenced);
        if matches!(
            outcome,
            RunOutcome::Interrupted | RunOutcome::Failed | RunOutcome::Unknown
        ) {
            self.stop_wait_children(&run.run_id);
        }
        self.host.forget_wait_mode(&run.run_id);
        self.host.stream_clear(&self.id);
        let run_id = run.run_id.clone();
        drop(run);
        let status = match outcome {
            RunOutcome::Completed => ChildResultStatus::Completed,
            RunOutcome::Failed => ChildResultStatus::Failed,
            RunOutcome::Interrupted => ChildResultStatus::Interrupted,
            RunOutcome::Unknown => ChildResultStatus::Unknown,
        };
        self.after_run(Some(run_id), status).await;
        self.arm_idle();
        self.maybe_start();
    }

    /// After a run of a worker: report to the parent (waiters first, then the parent's log).
    async fn after_run(&mut self, run_id: Option<RunId>, mut status: ChildResultStatus) {
        let Some(parent) = self.parent.clone() else {
            return;
        };
        let rt = self.host.runtime_of(&self.id).unwrap_or_default();
        let mut summary = rt.last_answer.clone();
        if let Some((outcome, text)) = rt.report {
            summary = match outcome {
                ReportOutcome::Succeeded => text,
                ReportOutcome::Failed => text,
                ReportOutcome::Blocked => format!("blocked: {text}"),
                ReportOutcome::Cancelled => format!("cancelled: {text}"),
            };
            status = match outcome {
                ReportOutcome::Succeeded => ChildResultStatus::Completed,
                ReportOutcome::Failed | ReportOutcome::Blocked => ChildResultStatus::Failed,
                ReportOutcome::Cancelled => ChildResultStatus::Interrupted,
            };
        }
        let store = &self.host.inner.store;
        let cursor = ThreadCursor {
            epoch: store
                .thread_epoch(&self.id)
                .unwrap_or_else(|| goat2_contracts::Epoch::new("")),
            seq: store.last_seq(&self.id).unwrap_or(0),
        };
        let outcome = ChildOutcome {
            child_thread_id: self.id.clone(),
            child_run_id: run_id,
            status,
            summary: clamp_bytes(&summary, CHILD_SUMMARY_MAX_BYTES),
            cursor,
        };
        // The parent records the result first, then releases waiters (child_result).
        self.host.send(
            &parent,
            Msg::ChildResult {
                outcome,
                delivered_in_wait: false,
            },
        );
    }

    /// Parent side: record `child.reported` first, then wake with an input (PRD runtime.md).
    async fn child_result(&mut self, outcome: ChildOutcome, _delivered_in_wait: bool) {
        let child_title = self
            .host
            .inner
            .store
            .card(&outcome.child_thread_id)
            .map(|c| c.title)
            .unwrap_or_default();
        let reported = ChildReported {
            child_thread_id: outcome.child_thread_id.clone(),
            child_run_id: outcome.child_run_id.clone(),
            status: outcome.status,
            summary: outcome.summary.clone(),
            child_cursor: outcome.cursor.clone(),
        };
        // A wait still blocked on this child gets the result in its tool call, so no extra wake
        // input (owner 2026-11-28). Record first, then release the waiter.
        if self.host.has_live_waiter(&outcome.child_thread_id) {
            if self
                .append(vec![LogEvent::ChildReported(reported.clone())])
                .is_some()
                && self.host.deliver_to_waiters(&outcome)
            {
                return;
            }
            // The waiter went away in between: fall through to a normal wake.
            let _ = self
                .accept_with(wake_input(&outcome, &child_title), Vec::new())
                .await;
            return;
        }
        let _ = self
            .accept_with(
                wake_input(&outcome, &child_title),
                vec![LogEvent::ChildReported(reported)],
            )
            .await;
    }

    // ------------------------------------------------------------------ stop / requests / queue

    fn stop_wait_children(&self, run_id: &RunId) {
        for child in self.host.wait_mode_children(run_id) {
            self.host.send(
                &child,
                Msg::Stop {
                    hold: false,
                    reply: None,
                },
            );
        }
        self.host.drop_waiters_of(run_id);
    }

    async fn stop(&mut self, hold: bool) -> Option<RunId> {
        if hold {
            self.held = true;
        }
        match &self.phase {
            Phase::Idle => None,
            // Not running yet: do not start (v1 ChildNeedsStop.ts:10 counts queued, preparing and
            // starting work). Inputs stay queued under a hold; a late permit or process start is
            // ignored (phase/pgen fence).
            Phase::WaitingPermit | Phase::Starting(_) => {
                self.held = true;
                if matches!(self.phase, Phase::Starting(_)) {
                    self.pgen += 1;
                    self.host.revoke_tokens(&self.id);
                }
                self.phase = Phase::Idle;
                None
            }
            Phase::Running(run) => {
                let (run_id, turn_id) = (run.run_id.clone(), run.turn_id.clone());
                self.stop_wait_children(&run_id);
                if turn_id.is_empty() {
                    self.finish_run(RunOutcome::Interrupted, Some("stopped".to_owned()))
                        .await;
                } else {
                    self.interrupt_or_fence(&turn_id).await;
                }
                Some(run_id)
            }
        }
    }

    async fn resolve(&mut self, r: Resolution) -> Result<(), Refusal> {
        let fold = self
            .host
            .inner
            .store
            .fold(&self.id)
            .ok_or_else(|| Refusal::new(Reason::ThreadNotFound, "thread not found"))?;
        let request = fold
            .open_requests
            .iter()
            .find(|q| q.request_id == r.request_id)
            .cloned()
            .ok_or_else(|| Refusal::new(Reason::RequestNotFound, "request is not open"))?;
        let allowed = match request.kind {
            RequestKind::Resend => {
                matches!(r.outcome, RequestOutcome::Resend | RequestOutcome::Dropped)
            }
            RequestKind::Decision => {
                matches!(r.outcome, RequestOutcome::Decided | RequestOutcome::Cancel)
            }
            RequestKind::Approval => matches!(
                r.outcome,
                RequestOutcome::Accept
                    | RequestOutcome::AcceptForSession
                    | RequestOutcome::Decline
                    | RequestOutcome::Cancel
            ),
            RequestKind::Question | RequestKind::Signin => {
                matches!(
                    r.outcome,
                    RequestOutcome::Answered | RequestOutcome::Cancel | RequestOutcome::Decline
                )
            }
        };
        if !allowed {
            return Err(Refusal::new(
                Reason::InvalidRequest,
                format!(
                    "outcome {:?} does not fit a {:?} request",
                    r.outcome, request.kind
                ),
            ));
        }
        let chosen =
            if request.kind == RequestKind::Decision && r.outcome == RequestOutcome::Decided {
                let options = request.options.clone().unwrap_or_default();
                let id = r.option_id.clone().unwrap_or_default();
                Some(options.into_iter().find(|o| o.id == id).ok_or_else(|| {
                    Refusal::new(Reason::InvalidRequest, "optionId is not one of the options")
                })?)
            } else {
                None
            };
        // Engine request of the running turn: answer the engine first.
        let engine_key = match &self.phase {
            Phase::Running(run) => run
                .engine_requests
                .iter()
                .find(|(_, id)| id == &r.request_id)
                .map(|(k, _)| k.clone()),
            _ => None,
        };
        if let (Some(key), Some(session)) = (&engine_key, &self.session) {
            session
                .session
                .answer_request(
                    key,
                    RequestAnswer {
                        outcome: r.outcome,
                        text: r.text.clone(),
                        answers: r.answers.clone(),
                    },
                )
                .await
                .map_err(|e| Refusal::new(Reason::Internal, e.to_string()))?;
            if let Phase::Running(run) = &mut self.phase {
                run.engine_requests.retain(|(k, _)| k != key);
            }
        } else if request.item_id.is_some()
            && !matches!(request.kind, RequestKind::Resend | RequestKind::Signin)
            && r.outcome != RequestOutcome::Cancel
        {
            return Err(Refusal::new(
                Reason::NotAllowed,
                "the engine that asked has stopped; the request can only be cancelled",
            ));
        }
        self.host
            .append(
                &self.id,
                vec![LogEvent::RequestResolved(RequestResolved {
                    request_id: r.request_id.clone(),
                    outcome: r.outcome,
                    option_id: r.option_id.clone(),
                    text: r.text.clone(),
                    answers: r.answers.clone(),
                })],
            )
            .map_err(|e| self.store_err(e))?;
        if request.kind == RequestKind::Signin {
            self.host.forget_signin_link(&r.request_id);
        }
        // An agent's own question (MCP request.ask): the answer comes back as an input.
        if request.item_id.is_none()
            && request.kind != RequestKind::Resend
            && r.outcome != RequestOutcome::Cancel
        {
            let answer = match (&chosen, &r.text) {
                (Some(option), _) => format!("chose \"{}\" ({})", option.label, option.id),
                (None, Some(text)) => text.clone(),
                (None, None) => format!("{:?}", r.outcome).to_lowercase(),
            };
            let _ = self
                .accept(NewInput {
                    from: InputSource::System,
                    text: format!("[answer to \"{}\"] {answer}", request.summary),
                    attachments: Vec::new(),
                    mode: Some(InputMode::Followup),
                    client_request_id: format!("answer:{}", r.request_id),
                })
                .await;
        }
        Ok(())
    }

    async fn edit_queue(&mut self, edit: QueueEdit) -> Result<(), Refusal> {
        let pending = self.pending();
        let is_queued = |id: &InputId| pending.iter().any(|q| &q.input_id == id);
        let not_queued = || Refusal::new(Reason::NotQueued, "the input is no longer queued");
        let change = |input_id: InputId| InputChanged {
            input_id,
            text: None,
            mode: None,
            cancelled: None,
            position: None,
        };
        let events = match edit {
            QueueEdit::Edit { input_id, text } => {
                if !is_queued(&input_id) {
                    return Err(not_queued());
                }
                vec![LogEvent::InputChanged(InputChanged {
                    text: Some(text),
                    ..change(input_id)
                })]
            }
            QueueEdit::Cancel { input_id } => {
                if !is_queued(&input_id) {
                    return Err(not_queued());
                }
                vec![LogEvent::InputChanged(InputChanged {
                    cancelled: Some(true),
                    ..change(input_id)
                })]
            }
            QueueEdit::Reorder { input_ids } => {
                if input_ids.iter().any(|id| !is_queued(id)) {
                    return Err(not_queued());
                }
                let fold = self.host.inner.store.fold(&self.id).unwrap_or_default();
                // Positions are indexes in the whole queue (including the active run's inputs).
                let offset = fold.queued_inputs.len() - pending.len();
                input_ids
                    .into_iter()
                    .enumerate()
                    .map(|(i, id)| {
                        LogEvent::InputChanged(InputChanged {
                            position: Some((offset + i) as u32),
                            ..change(id)
                        })
                    })
                    .collect()
            }
            QueueEdit::PromoteToSteer { input_id } => {
                let Some(q) = pending.iter().find(|q| q.input_id == input_id).cloned() else {
                    return Err(not_queued());
                };
                if !matches!(self.phase, Phase::Running(_)) {
                    return Err(Refusal::new(Reason::SteerRefused, "no run to steer into"));
                }
                self.host
                    .append(
                        &self.id,
                        vec![LogEvent::InputChanged(InputChanged {
                            mode: Some(InputMode::Steer),
                            ..change(input_id)
                        })],
                    )
                    .map_err(|e| self.store_err(e))?;
                self.steer_now(&QueuedInput {
                    mode: InputMode::Steer,
                    ..q
                })
                .await?;
                return Ok(());
            }
        };
        self.host
            .append(&self.id, events)
            .map_err(|e| self.store_err(e))?;
        Ok(())
    }

    // ------------------------------------------------------------------ session lifetime

    fn arm_idle(&mut self) {
        self.idle_gen += 1;
        let (gen_, tx, after) = (
            self.idle_gen,
            self.tx.clone(),
            self.host.inner.opts.idle_stop,
        );
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            let _ = tx.send(Msg::IdleCheck(gen_));
        });
    }

    fn drop_session(&mut self) {
        self.turn_runs.clear();
        self.live_subagents.clear();
        let signins = std::mem::take(&mut self.session_signins);
        let closed = self.close_signins(&signins, "the engine stopped");
        if !closed.is_empty() {
            self.append(closed);
        }
        if let Some(s) = self.session.take() {
            let mut sessions = self.host.inner.sessions.lock().expect("sessions");
            if sessions.get(&self.id).is_some_and(|(p, _)| *p == s.pgen) {
                sessions.remove(&self.id);
            }
            drop(sessions);
            self.host.engine_groups_changed();
        }
        self.host.revoke_tokens(&self.id);
    }

    async fn stop_session(&mut self, why: &str) {
        if let Some(s) = &self.session {
            tracing::info!(thread = %self.id, why, "stopping engine process");
            s.session.shutdown().await;
        }
        self.drop_session();
        // Events from the stopped process are ignored from here on.
        self.pgen += 1;
    }
}

/// The persisted `request.opened` summary of a sign-in. It is constant: an engine message can
/// carry codes or tokens in forms no redaction reliably finds (URL paths, `mailto:`, brackets in
/// a path, bare codes), so none of it goes to `goat.jsonl`. The message and link stay in memory
/// only ([crate::core::SigninLink]).
const SIGNIN_SUMMARY: &str = "Sign in to continue";

/// Turns of one engine session remembered for late items.
const TURN_RUNS_KEPT: usize = 64;

/// A subagent status after which nothing more happens.
fn is_terminal(status: goat2_contracts::TurnItemStatus) -> bool {
    use goat2_contracts::TurnItemStatus as S;
    matches!(
        status,
        S::Completed | S::Failed | S::Cancelled | S::Interrupted
    )
}

/// The parent's wake input for a child result. The clientRequestId names (child, child run).
pub(crate) fn wake_input(outcome: &ChildOutcome, child_title: &str) -> NewInput {
    let status = serde_json::to_value(outcome.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let text = format!(
        "[child thread {} \"{}\" finished: {}]\n{}",
        outcome.child_thread_id, child_title, status, outcome.summary
    );
    NewInput {
        from: InputSource::Child {
            thread_id: outcome.child_thread_id.clone(),
        },
        text,
        attachments: Vec::new(),
        mode: None,
        client_request_id: format!(
            "child:{}:{}",
            outcome.child_thread_id,
            outcome
                .child_run_id
                .as_ref()
                .map_or("restart", |r| r.as_str())
        ),
    }
}

/// Inputs for the next run: an interrupt input alone; else the head, plus following child
/// results (coalesced wake) or following collect inputs.
fn take_batch(pending: &[QueuedInput]) -> Vec<QueuedInput> {
    if let Some(q) = pending.iter().find(|q| q.mode == InputMode::Interrupt) {
        return vec![q.clone()];
    }
    let Some(head) = pending.first() else {
        return Vec::new();
    };
    let same: fn(&QueuedInput, &QueuedInput) -> bool = match (&head.source, head.mode) {
        (InputSource::Child { .. }, _) => |_, q| matches!(q.source, InputSource::Child { .. }),
        (_, InputMode::Collect) => |_, q| q.mode == InputMode::Collect,
        _ => return vec![head.clone()],
    };
    pending
        .iter()
        .take_while(|q| same(head, q))
        .cloned()
        .collect()
}

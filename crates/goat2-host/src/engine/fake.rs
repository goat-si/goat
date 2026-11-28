//! Scripted engine for tests and for UI work without Codex (`GOAT2_ENGINE=fake`).
//!
//! By default every turn streams `fake reply: <input text>` and finishes `Done` after
//! [FakeScript::turn_ms]. Tests switch `auto_finish` off and drive events with
//! [FakeEngine::emit], queue specific turn/steer answers, and read the recorded calls.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use goat2_contracts::{
    AssistantMessagePhase, EngineDriver, EngineItemLocator, EngineRef, ItemId, MessageId, ThreadId,
    TurnItem, TurnItemBody, TurnItemStatus,
};
use tokio::sync::mpsc;

use super::{
    EngineError, EngineEvent, EngineFactory, EngineHandle, EngineInput, EngineSession,
    RequestAnswer, SessionSpec, SteerResult, TurnOutcome, TurnSettings, TurnStartResult,
};
use crate::util::{new_id, now_rfc3339};

/// Knobs shared by every fake session.
#[derive(Debug, Clone)]
pub struct FakeScript {
    /// Finish every turn by itself after `turn_ms`.
    pub auto_finish: bool,
    pub turn_ms: u64,
    /// Time a process start takes.
    pub start_ms: u64,
    /// Fail every process start with this reason.
    pub fail_start: Option<String>,
}

impl Default for FakeScript {
    fn default() -> Self {
        Self {
            auto_finish: true,
            turn_ms: 50,
            start_ms: 0,
            fail_start: None,
        }
    }
}

/// A call the host made, for assertions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FakeCall {
    Start {
        thread_id: ThreadId,
        resume: Option<String>,
        process_generation: u64,
        mcp_token: String,
    },
    Turn {
        thread_id: ThreadId,
        turn_id: String,
        input_ids: Vec<String>,
        model: String,
    },
    Steer {
        thread_id: ThreadId,
        turn_id: String,
        input_ids: Vec<String>,
    },
    Interrupt {
        thread_id: ThreadId,
        turn_id: String,
    },
    Answer {
        thread_id: ThreadId,
        key: String,
        outcome: goat2_contracts::RequestOutcome,
    },
    Continuation {
        thread_id: ThreadId,
        key: String,
        turn_id: Option<String>,
        input_ids: Vec<String>,
    },
    Shutdown {
        thread_id: ThreadId,
    },
}

#[derive(Default)]
struct Shared {
    script: FakeScript,
    calls: Vec<FakeCall>,
    turn_results: HashMap<ThreadId, VecDeque<TurnStartResult>>,
    steer_results: HashMap<ThreadId, VecDeque<SteerResult>>,
    /// When set, start_continuation answers Declined (the engine no longer holds the key).
    decline_continuations: bool,
    /// When set, start_continuation answers Unknown (no answer from the engine).
    unknown_continuations: bool,
    /// How long start_continuation takes before it answers.
    continuation_delay: Duration,
    senders: HashMap<ThreadId, mpsc::UnboundedSender<EngineEvent>>,
    active_turn: HashMap<ThreadId, String>,
    rss: HashMap<ThreadId, u64>,
    pgids: HashMap<ThreadId, i32>,
    /// When set, answer_request fails with an error naming the key (as the Codex driver does).
    fail_answers: bool,
    /// What [EngineFactory::probe] answers; `None` = Unsupported (the trait default).
    probe: Option<Result<goat2_contracts::ProviderProbeResult, EngineError>>,
    /// How long a probe takes.
    probe_delay: Duration,
    /// How many probes ran.
    probes: usize,
    /// The provider instances probes and session starts were handed, in order.
    probe_targets: Vec<crate::engine::ProviderTarget>,
    start_targets: Vec<Option<crate::engine::ProviderTarget>>,
    /// Provider sign-in/install: `None` = Unsupported (the trait defaults).
    setup: Option<goat2_contracts::ProviderSetup>,
    auth: Option<(
        Vec<goat2_contracts::ProviderAuthMethod>,
        goat2_contracts::ProviderAuthState,
    )>,
    auth_updates: Option<mpsc::UnboundedSender<goat2_contracts::ProviderAuthState>>,
    auth_starts: usize,
    /// Sign-in answers seen: (flow id, interaction id, credential field names). Values are
    /// never kept, like a real driver.
    auth_responses: Vec<(String, String, Vec<String>)>,
    /// When set, auth_respond answers with this flow id and phase instead of the requested
    /// flow and Verifying.
    auth_respond_answer: Option<(Option<String>, goat2_contracts::ProviderAuthPhase)>,
    install: Option<goat2_contracts::ProviderInstallState>,
    install_updates: Option<mpsc::UnboundedSender<goat2_contracts::ProviderInstallState>>,
}

/// The fake engine factory. Clone it to keep a control handle.
#[derive(Clone, Default)]
pub struct FakeEngine {
    shared: Arc<Mutex<Shared>>,
    starting: Arc<AtomicUsize>,
    max_starting: Arc<AtomicUsize>,
}

impl FakeEngine {
    pub fn new(script: FakeScript) -> Self {
        let engine = Self::default();
        engine.shared.lock().expect("fake").script = script;
        engine
    }

    /// Make every later answer_request fail with an error that names the key.
    pub fn fail_answers(&self, fail: bool) {
        self.shared.lock().expect("fake").fail_answers = fail;
    }

    pub fn set_script(&self, script: FakeScript) {
        self.shared.lock().expect("fake").script = script;
    }

    pub fn calls(&self) -> Vec<FakeCall> {
        self.shared.lock().expect("fake").calls.clone()
    }

    /// The most concurrent process starts seen.
    pub fn max_concurrent_starts(&self) -> usize {
        self.max_starting.load(Ordering::SeqCst)
    }

    pub fn push_turn_result(&self, thread_id: &ThreadId, result: TurnStartResult) {
        let mut shared = self.shared.lock().expect("fake");
        shared
            .turn_results
            .entry(thread_id.clone())
            .or_default()
            .push_back(result);
    }

    pub fn push_steer_result(&self, thread_id: &ThreadId, result: SteerResult) {
        let mut shared = self.shared.lock().expect("fake");
        shared
            .steer_results
            .entry(thread_id.clone())
            .or_default()
            .push_back(result);
    }

    /// The process group id a thread's fake process reports.
    pub fn set_pgid(&self, thread_id: &ThreadId, pgid: i32) {
        self.shared
            .lock()
            .expect("fake")
            .pgids
            .insert(thread_id.clone(), pgid);
    }

    pub fn set_rss(&self, thread_id: &ThreadId, bytes: u64) {
        self.shared
            .lock()
            .expect("fake")
            .rss
            .insert(thread_id.clone(), bytes);
    }

    /// What the next probes answer.
    pub fn set_probe(&self, probe: Result<goat2_contracts::ProviderProbeResult, EngineError>) {
        self.shared.lock().expect("fake").probe = Some(probe);
    }

    /// Make every probe take `delay`.
    pub fn set_probe_delay(&self, delay: Duration) {
        self.shared.lock().expect("fake").probe_delay = delay;
    }

    /// Make start_continuation answer Declined (the engine no longer holds the key).
    pub fn decline_continuations(&self, decline: bool) {
        self.shared.lock().expect("fake").decline_continuations = decline;
    }

    /// Make start_continuation answer Unknown (no answer from the engine).
    pub fn unknown_continuations(&self, unknown: bool) {
        self.shared.lock().expect("fake").unknown_continuations = unknown;
    }

    /// Make start_continuation take `delay` before it answers.
    pub fn set_continuation_delay(&self, delay: Duration) {
        self.shared.lock().expect("fake").continuation_delay = delay;
    }

    /// How many probes ran so far.
    pub fn probes(&self) -> usize {
        self.shared.lock().expect("fake").probes
    }

    /// The instances probes were run for, in order.
    pub fn probe_targets(&self) -> Vec<crate::engine::ProviderTarget> {
        self.shared.lock().expect("fake").probe_targets.clone()
    }

    /// The instance each session start was handed, in order.
    pub fn start_targets(&self) -> Vec<Option<crate::engine::ProviderTarget>> {
        self.shared.lock().expect("fake").start_targets.clone()
    }

    /// Offer sign-in (`methods`, answering a start with `start`) and install (answering with
    /// `install`).
    pub fn set_provider_setup(
        &self,
        auth: Option<(
            Vec<goat2_contracts::ProviderAuthMethod>,
            goat2_contracts::ProviderAuthState,
        )>,
        install: Option<goat2_contracts::ProviderInstallState>,
    ) {
        let mut shared = self.shared.lock().expect("fake");
        shared.setup = Some(goat2_contracts::ProviderSetup {
            can_authenticate: auth.is_some(),
            can_install: install.is_some(),
            documentation_url: None,
        });
        shared.auth = auth;
        shared.install = install;
    }

    /// The update channel of the last sign-in start, to send its later phases.
    pub fn auth_updates(
        &self,
    ) -> Option<mpsc::UnboundedSender<goat2_contracts::ProviderAuthState>> {
        self.shared.lock().expect("fake").auth_updates.clone()
    }

    pub fn auth_starts(&self) -> usize {
        self.shared.lock().expect("fake").auth_starts
    }

    /// Sign-in answers seen: (flow id, interaction id, credential field names).
    pub fn auth_responses(&self) -> Vec<(String, String, Vec<String>)> {
        self.shared.lock().expect("fake").auth_responses.clone()
    }

    /// Make auth_respond answer with `flow_id` and `phase` (a driver that names another flow,
    /// or checks a key on submit).
    pub fn set_auth_respond_answer(
        &self,
        flow_id: Option<&str>,
        phase: goat2_contracts::ProviderAuthPhase,
    ) {
        self.shared.lock().expect("fake").auth_respond_answer =
            Some((flow_id.map(str::to_owned), phase));
    }

    /// The update channel of the last install start.
    pub fn install_updates(
        &self,
    ) -> Option<mpsc::UnboundedSender<goat2_contracts::ProviderInstallState>> {
        self.shared.lock().expect("fake").install_updates.clone()
    }

    /// The turn currently running in a thread's fake process.
    pub fn active_turn(&self, thread_id: &ThreadId) -> Option<String> {
        self.shared
            .lock()
            .expect("fake")
            .active_turn
            .get(thread_id)
            .cloned()
    }

    /// Send an event from a thread's fake process. Returns false when no process is running.
    pub fn emit(&self, thread_id: &ThreadId, event: EngineEvent) -> bool {
        let mut shared = self.shared.lock().expect("fake");
        if let EngineEvent::TurnFinished { .. } = &event {
            shared.active_turn.remove(thread_id);
        }
        shared
            .senders
            .get(thread_id)
            .is_some_and(|tx| tx.send(event).is_ok())
    }

    /// Emit a content delta for the current turn.
    pub fn content_delta(
        &self,
        thread_id: &ThreadId,
        item_id: ItemId,
        stream_kind: goat2_contracts::ContentStreamKind,
        text: &str,
    ) -> bool {
        let Some(turn_id) = self.active_turn(thread_id) else {
            return false;
        };
        self.emit(
            thread_id,
            EngineEvent::ContentDelta {
                turn_id,
                item_id,
                stream_kind,
                text: text.to_owned(),
            },
        )
    }

    /// Finish the running turn with a final answer.
    pub fn finish_turn(&self, thread_id: &ThreadId, answer: &str) -> bool {
        let Some(turn_id) = self.active_turn(thread_id) else {
            return false;
        };
        for event in reply_events(thread_id, &turn_id, answer) {
            self.emit(thread_id, event);
        }
        self.emit(
            thread_id,
            EngineEvent::TurnFinished {
                turn_id,
                outcome: TurnOutcome::Done,
            },
        )
    }

    /// End a thread's process as if it crashed.
    pub fn crash(&self, thread_id: &ThreadId, reason: &str) -> bool {
        let tx = {
            let mut shared = self.shared.lock().expect("fake");
            shared.active_turn.remove(thread_id);
            shared.senders.remove(thread_id)
        };
        tx.is_some_and(|tx| {
            tx.send(EngineEvent::Exited {
                reason: reason.to_owned(),
            })
            .is_ok()
        })
    }
}

/// A streamed final answer: one delta, then the completed item.
pub fn reply_events(thread_id: &ThreadId, turn_id: &str, answer: &str) -> Vec<EngineEvent> {
    let item_id = ItemId::new(new_id("item"));
    vec![
        EngineEvent::TextDelta {
            turn_id: turn_id.to_owned(),
            item_id: item_id.clone(),
            text: answer.to_owned(),
        },
        EngineEvent::ItemCompleted {
            turn_id: turn_id.to_owned(),
            item: Box::new(assistant_item(thread_id, &item_id, turn_id, answer)),
            locator: Some(EngineItemLocator {
                turn_id: turn_id.to_owned(),
                item_id: item_id.to_string(),
            }),
        },
    ]
}

/// A completed final-answer item.
pub fn assistant_item(
    thread_id: &ThreadId,
    item_id: &ItemId,
    turn_id: &str,
    text: &str,
) -> TurnItem {
    let now = now_rfc3339();
    TurnItem {
        id: item_id.clone(),
        thread_id: thread_id.clone(),
        run_id: None,
        provider_thread_id: None,
        provider_turn_id: Some(turn_id.to_owned()),
        native_item_ref: None,
        parent_item_id: None,
        ordinal: 0,
        status: TurnItemStatus::Completed,
        title: None,
        started_at: Some(now.clone()),
        completed_at: Some(now.clone()),
        updated_at: now,
        body: TurnItemBody::AssistantMessage {
            phase: Some(AssistantMessagePhase::FinalAnswer),
            delivery: None,
            message_id: MessageId::new(new_id("msg")),
            text: text.to_owned(),
            attachments: None,
            streaming: false,
        },
    }
}

struct FakeSession {
    thread_id: ThreadId,
    engine: FakeEngine,
    tx: mpsc::UnboundedSender<EngineEvent>,
}

#[async_trait]
impl EngineFactory for FakeEngine {
    /// The fake stands in for Codex, so it reports v1's Codex capabilities.
    fn capabilities(&self) -> goat2_contracts::ProviderCapabilities {
        super::codex::codex_capabilities()
    }

    async fn probe(&self) -> Result<goat2_contracts::ProviderProbeResult, EngineError> {
        let (probe, delay) = {
            let mut shared = self.shared.lock().expect("fake");
            shared.probes += 1;
            (shared.probe.clone(), shared.probe_delay)
        };
        tokio::time::sleep(delay).await;
        probe.unwrap_or_else(|| Err(EngineError::Unsupported("probe".into())))
    }

    async fn probe_instance(
        &self,
        target: &crate::engine::ProviderTarget,
    ) -> Result<goat2_contracts::ProviderProbeResult, EngineError> {
        self.shared
            .lock()
            .expect("fake")
            .probe_targets
            .push(target.clone());
        self.probe().await
    }

    fn setup(&self) -> goat2_contracts::ProviderSetup {
        self.shared
            .lock()
            .expect("fake")
            .setup
            .clone()
            .unwrap_or(goat2_contracts::ProviderSetup {
                can_authenticate: false,
                can_install: false,
                documentation_url: None,
            })
    }

    async fn auth_methods(
        &self,
        _target: &super::ProviderTarget,
    ) -> Result<Vec<goat2_contracts::ProviderAuthMethod>, EngineError> {
        let shared = self.shared.lock().expect("fake");
        shared
            .auth
            .as_ref()
            .map(|(methods, _)| methods.clone())
            .ok_or_else(|| EngineError::Unsupported("auth_methods".into()))
    }

    async fn auth_start(
        &self,
        _target: &super::ProviderTarget,
        _method_id: Option<String>,
        updates: mpsc::UnboundedSender<goat2_contracts::ProviderAuthState>,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        let mut shared = self.shared.lock().expect("fake");
        let Some((_, start)) = shared.auth.clone() else {
            return Err(EngineError::Unsupported("auth_start".into()));
        };
        shared.auth_starts += 1;
        shared.auth_updates = Some(updates);
        Ok(start)
    }

    async fn auth_cancel(
        &self,
        target: &super::ProviderTarget,
        flow_id: &str,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        let shared = self.shared.lock().expect("fake");
        let Some((_, start)) = shared.auth.clone() else {
            return Err(EngineError::Unsupported("auth_cancel".into()));
        };
        Ok(goat2_contracts::ProviderAuthState {
            instance_id: target.instance_id.clone(),
            phase: goat2_contracts::ProviderAuthPhase::Cancelled,
            flow_id: Some(flow_id.to_owned()),
            authorization_url: None,
            ..start
        })
    }

    /// Records only the field names of a credentials answer (never the values) and answers the
    /// flow as verifying.
    async fn auth_respond(
        &self,
        target: &super::ProviderTarget,
        flow_id: &str,
        interaction_id: &str,
        response: goat2_contracts::ProviderAuthResponse,
    ) -> Result<goat2_contracts::ProviderAuthState, EngineError> {
        let mut shared = self.shared.lock().expect("fake");
        let Some((_, start)) = shared.auth.clone() else {
            return Err(EngineError::Unsupported("auth_respond".into()));
        };
        let goat2_contracts::ProviderAuthResponse::Credentials { values } = response else {
            return Err(EngineError::Unsupported("auth_respond".into()));
        };
        shared.auth_responses.push((
            flow_id.to_owned(),
            interaction_id.to_owned(),
            values.into_keys().collect(),
        ));
        let (flow_id, phase) = shared.auth_respond_answer.clone().unwrap_or((
            Some(flow_id.to_owned()),
            goat2_contracts::ProviderAuthPhase::Verifying,
        ));
        Ok(goat2_contracts::ProviderAuthState {
            instance_id: target.instance_id.clone(),
            phase,
            flow_id,
            authorization_url: None,
            ..start
        })
    }

    async fn install_start(
        &self,
        _launch: Option<&super::LaunchSpec>,
        updates: mpsc::UnboundedSender<goat2_contracts::ProviderInstallState>,
    ) -> Result<goat2_contracts::ProviderInstallState, EngineError> {
        let mut shared = self.shared.lock().expect("fake");
        let Some(start) = shared.install.clone() else {
            return Err(EngineError::Unsupported("install_start".into()));
        };
        shared.install_updates = Some(updates);
        Ok(start)
    }

    async fn start(&self, spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        let now = self.starting.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_starting.fetch_max(now, Ordering::SeqCst);
        let script = self.shared.lock().expect("fake").script.clone();
        if script.start_ms > 0 {
            tokio::time::sleep(Duration::from_millis(script.start_ms)).await;
        }
        self.starting.fetch_sub(1, Ordering::SeqCst);
        if let Some(reason) = script.fail_start {
            return Err(EngineError::StartFailed(reason));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let engine_id = spec
            .resume
            .as_ref()
            .map(|r| r.id.clone())
            .unwrap_or_else(|| new_id("fakethread"));
        {
            let mut shared = self.shared.lock().expect("fake");
            shared.start_targets.push(spec.instance.clone());
            shared.calls.push(FakeCall::Start {
                thread_id: spec.thread_id.clone(),
                resume: spec.resume.as_ref().map(|r| r.id.clone()),
                process_generation: spec.process_generation,
                mcp_token: spec.mcp.bearer_token.clone(),
            });
            shared.senders.insert(spec.thread_id.clone(), tx.clone());
        }
        Ok(EngineHandle {
            session: Box::new(FakeSession {
                thread_id: spec.thread_id,
                engine: self.clone(),
                tx,
            }),
            events: rx,
            engine_ref: EngineRef {
                driver: EngineDriver::Codex,
                id: engine_id,
            },
        })
    }
}

fn ids(inputs: &[EngineInput]) -> Vec<String> {
    inputs.iter().map(|i| i.input_id.to_string()).collect()
}

#[async_trait]
impl EngineSession for FakeSession {
    async fn start_turn(
        &self,
        inputs: Vec<EngineInput>,
        settings: &TurnSettings,
    ) -> TurnStartResult {
        let (result, script) = {
            let mut shared = self.engine.shared.lock().expect("fake");
            let result = shared
                .turn_results
                .get_mut(&self.thread_id)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| TurnStartResult::Accepted {
                    turn_id: new_id("turn"),
                });
            if let TurnStartResult::Accepted { turn_id } = &result {
                shared.calls.push(FakeCall::Turn {
                    thread_id: self.thread_id.clone(),
                    turn_id: turn_id.clone(),
                    input_ids: ids(&inputs),
                    model: settings.model_selection.model.clone(),
                });
                shared
                    .active_turn
                    .insert(self.thread_id.clone(), turn_id.clone());
            }
            (result, shared.script.clone())
        };
        if let (TurnStartResult::Accepted { turn_id }, true) = (&result, script.auto_finish) {
            let text = inputs
                .iter()
                .map(|i| i.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let events = reply_events(&self.thread_id, turn_id, &format!("fake reply: {text}"));
            let (tx, turn_id, engine, thread_id) = (
                self.tx.clone(),
                turn_id.clone(),
                self.engine.clone(),
                self.thread_id.clone(),
            );
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(script.turn_ms)).await;
                if engine.active_turn(&thread_id).as_deref() != Some(turn_id.as_str()) {
                    return;
                }
                for event in events {
                    let _ = tx.send(event);
                }
                engine
                    .shared
                    .lock()
                    .expect("fake")
                    .active_turn
                    .remove(&thread_id);
                let _ = tx.send(EngineEvent::TurnFinished {
                    turn_id,
                    outcome: TurnOutcome::Done,
                });
            });
        }
        result
    }

    async fn start_continuation(
        &self,
        key: &str,
        inputs: Vec<EngineInput>,
        _settings: &TurnSettings,
    ) -> TurnStartResult {
        let delay = self.engine.shared.lock().expect("fake").continuation_delay;
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let mut shared = self.engine.shared.lock().expect("fake");
        let result = if shared.decline_continuations {
            TurnStartResult::Declined {
                reason: "continuation no longer available".into(),
            }
        } else if shared.unknown_continuations {
            TurnStartResult::Unknown {
                reason: "no answer".into(),
            }
        } else {
            TurnStartResult::Accepted {
                turn_id: new_id("turn"),
            }
        };
        let turn_id = match &result {
            TurnStartResult::Accepted { turn_id } => {
                shared
                    .active_turn
                    .insert(self.thread_id.clone(), turn_id.clone());
                Some(turn_id.clone())
            }
            _ => None,
        };
        shared.calls.push(FakeCall::Continuation {
            thread_id: self.thread_id.clone(),
            key: key.to_owned(),
            turn_id,
            input_ids: ids(&inputs),
        });
        result
    }

    async fn steer(&self, turn_id: &str, inputs: Vec<EngineInput>) -> SteerResult {
        let mut shared = self.engine.shared.lock().expect("fake");
        let result = shared
            .steer_results
            .get_mut(&self.thread_id)
            .and_then(VecDeque::pop_front)
            .unwrap_or(SteerResult::Accepted);
        shared.calls.push(FakeCall::Steer {
            thread_id: self.thread_id.clone(),
            turn_id: turn_id.to_owned(),
            input_ids: ids(&inputs),
        });
        result
    }

    async fn interrupt(&self, turn_id: &str) -> Result<(), EngineError> {
        let was_active = {
            let mut shared = self.engine.shared.lock().expect("fake");
            shared.calls.push(FakeCall::Interrupt {
                thread_id: self.thread_id.clone(),
                turn_id: turn_id.to_owned(),
            });
            let active =
                shared.active_turn.get(&self.thread_id).map(String::as_str) == Some(turn_id);
            if active {
                shared.active_turn.remove(&self.thread_id);
            }
            active
        };
        if was_active {
            let _ = self.tx.send(EngineEvent::TurnFinished {
                turn_id: turn_id.to_owned(),
                outcome: TurnOutcome::Interrupted,
            });
        }
        Ok(())
    }

    async fn answer_request(&self, key: &str, answer: RequestAnswer) -> Result<(), EngineError> {
        let fail = {
            let mut shared = self.engine.shared.lock().expect("fake");
            shared.calls.push(FakeCall::Answer {
                thread_id: self.thread_id.clone(),
                key: key.to_owned(),
                outcome: answer.outcome,
            });
            shared.fail_answers
        };
        if fail {
            return Err(EngineError::Transport(format!("no pending request {key}")));
        }
        let _ = self.tx.send(EngineEvent::RequestClosed {
            key: key.to_owned(),
        });
        Ok(())
    }

    fn process_group_id(&self) -> Option<i32> {
        self.engine
            .shared
            .lock()
            .expect("fake")
            .pgids
            .get(&self.thread_id)
            .copied()
    }

    fn group_rss_bytes(&self) -> Option<u64> {
        self.engine
            .shared
            .lock()
            .expect("fake")
            .rss
            .get(&self.thread_id)
            .copied()
    }

    async fn shutdown(&self) {
        let mut shared = self.engine.shared.lock().expect("fake");
        shared.calls.push(FakeCall::Shutdown {
            thread_id: self.thread_id.clone(),
        });
        shared.senders.remove(&self.thread_id);
        shared.active_turn.remove(&self.thread_id);
    }
}

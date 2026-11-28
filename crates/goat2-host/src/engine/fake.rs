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
    senders: HashMap<ThreadId, mpsc::UnboundedSender<EngineEvent>>,
    active_turn: HashMap<ThreadId, String>,
    rss: HashMap<ThreadId, u64>,
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

    pub fn set_rss(&self, thread_id: &ThreadId, bytes: u64) {
        self.shared
            .lock()
            .expect("fake")
            .rss
            .insert(thread_id.clone(), bytes);
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
                    model: settings.model.clone(),
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

    async fn answer_request(&self, key: &str, _answer: RequestAnswer) -> Result<(), EngineError> {
        self.engine
            .shared
            .lock()
            .expect("fake")
            .calls
            .push(FakeCall::Answer {
                thread_id: self.thread_id.clone(),
                key: key.to_owned(),
            });
        let _ = self.tx.send(EngineEvent::RequestClosed {
            key: key.to_owned(),
        });
        Ok(())
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

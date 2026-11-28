//! Host core: shared state, the write path (append + broadcast), and startup settlement.
//!
//! Every thread has an actor (`actor.rs`) that owns its mailbox and lane: one run at a time,
//! follow-up modes, engine process, timers. Shared state here is what crosses threads: the
//! store, the scheduler, MCP tokens, the per-thread runtime snapshot MCP callers read, child
//! waiters, live broadcast channels and bots.

pub mod actor;
pub mod commands;
pub mod mcp_ops;
pub mod sched;
pub mod settle;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use goat2_contracts::limits::{
    CHILD_WAKE_COALESCE_MS, COLLECT_WINDOW_MS, ENGINE_GROUP_MEMORY_LIMIT_BYTES,
    ENGINE_IDLE_STOP_SECS, ENGINE_MEMORY_SAMPLE_SECS, ENGINE_MEMORY_WARN_PERCENT,
    MAX_CHILDREN_PER_BOT, MAX_CONCURRENT_RUNS, MAX_CONCURRENT_STARTS,
};
use goat2_contracts::{
    BotId, BotProfile, ChildResultStatus, ItemId, LogEvent, NotifyKind, RequestId, RunId,
    ThreadCursor, ThreadId, ThreadKind, text::utf16_len,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::api::{CardUpdate, McpGrant, ReportOutcome, StreamingItem, ThreadLive};
use crate::engine::{EngineFactory, EngineSession};
use crate::stall::StallRecorder;
use crate::store::{Appended, StoreResult, ThreadStore};
use actor::Msg;
use sched::Scheduler;

/// Tunables; [HostOptions::new] uses the Part 1 values, tests shrink the timers.
#[derive(Debug, Clone)]
pub struct HostOptions {
    pub data_dir: PathBuf,
    pub host_generation: u64,
    pub ui_token: String,
    /// Working folder for bots and threads started without one.
    pub default_cwd: String,
    pub max_runs: usize,
    pub max_starts: usize,
    pub max_children: usize,
    pub idle_stop: Duration,
    pub collect_window: Duration,
    pub child_coalesce: Duration,
    pub memory_limit_bytes: u64,
    pub memory_sample: Duration,
    /// Longest `thread.wait` / `thread.start {mode: wait}` block.
    pub max_wait: Duration,
}

impl HostOptions {
    pub fn new(
        data_dir: PathBuf,
        host_generation: u64,
        ui_token: String,
        default_cwd: String,
    ) -> Self {
        Self {
            data_dir,
            host_generation,
            ui_token,
            default_cwd,
            max_runs: MAX_CONCURRENT_RUNS,
            max_starts: MAX_CONCURRENT_STARTS,
            max_children: MAX_CHILDREN_PER_BOT,
            idle_stop: Duration::from_secs(ENGINE_IDLE_STOP_SECS),
            collect_window: Duration::from_millis(COLLECT_WINDOW_MS),
            child_coalesce: Duration::from_millis(CHILD_WAKE_COALESCE_MS),
            memory_limit_bytes: ENGINE_GROUP_MEMORY_LIMIT_BYTES,
            memory_sample: Duration::from_secs(ENGINE_MEMORY_SAMPLE_SECS),
            max_wait: Duration::from_secs(60),
        }
    }
}

/// What MCP callers and other threads may read about a thread without asking its actor.
#[derive(Debug, Clone, Default)]
pub struct Runtime {
    pub kind: Option<ThreadKind>,
    pub parent: Option<ThreadId>,
    /// Bumped on every engine start or resume.
    pub process_generation: u64,
    pub session_alive: bool,
    pub active_run: Option<RunId>,
    /// A run is active or inputs are queued.
    pub busy: bool,
    /// `thread.report_result` for the active run.
    pub report: Option<(ReportOutcome, String)>,
    /// `user.send` kinds already sent in the active run.
    pub notified: HashSet<NotifyKind>,
    /// Final answer text of the active run so far.
    pub last_answer: String,
    /// The active run's scheduler slot, parked while the run waits on a child.
    pub run_slot: Option<Arc<sched::RunSlot>>,
}

/// The link an engine asked the person to open to sign in (`EngineEvent::AuthRequired.url`), kept
/// for as long as its `signin` request is open. Memory only: such links often carry one-time
/// codes in their query, so they never go into the thread log, whose `request.opened` keeps a
/// bounded summary without them. The providers module hands the link to the UI as
/// `ServerProviderAuth.action` (`goat2_contracts::AcpRegistryUrlAuthAction`).
#[derive(Clone, PartialEq, Eq)]
pub struct SigninLink {
    pub thread_id: ThreadId,
    pub request_id: RequestId,
    pub url: String,
    pub message: String,
}

impl std::fmt::Debug for SigninLink {
    // The URL stays out of logs and panic messages.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SigninLink")
            .field("thread_id", &self.thread_id)
            .field("request_id", &self.request_id)
            .field("url", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// A finished child run, as delivered to waiters and the parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildOutcome {
    pub child_thread_id: ThreadId,
    pub child_run_id: Option<RunId>,
    pub status: ChildResultStatus,
    pub summary: String,
    pub cursor: ThreadCursor,
}

/// A parent run blocked on a child (`thread.start {mode: wait}` or `thread.wait`).
pub struct Waiter {
    pub parent_run: RunId,
    pub tx: oneshot::Sender<ChildOutcome>,
}

/// A running engine process: (process generation, session).
pub type LiveSession = (u64, Arc<dyn EngineSession>);

struct LiveThread {
    tx: broadcast::Sender<ThreadLive>,
    streaming: Vec<(ItemId, String)>,
}

pub(crate) struct Inner {
    pub opts: HostOptions,
    pub store: Arc<dyn ThreadStore>,
    pub engine: Arc<dyn EngineFactory>,
    pub sched: Arc<Scheduler>,
    pub stall: StallRecorder,
    pub mcp_url: OnceLock<String>,
    pub cards_tx: broadcast::Sender<CardUpdate>,
    live: Mutex<HashMap<ThreadId, LiveThread>>,
    actors: Mutex<HashMap<ThreadId, mpsc::UnboundedSender<Msg>>>,
    pub runtime: Mutex<HashMap<ThreadId, Runtime>>,
    pub tokens: Mutex<HashMap<String, McpGrant>>,
    pub waiters: Mutex<HashMap<ThreadId, Vec<Waiter>>>,
    /// Children started with `mode: wait` by a run, kept until the run ends: Stop or interrupt
    /// of that run stops them even after the wait call timed out (v1 task mode).
    pub wait_mode: Mutex<HashMap<RunId, HashSet<ThreadId>>>,
    /// Child slots reserved by in-flight starts, per parent (atomic cap check).
    pub child_reservations: Mutex<HashMap<ThreadId, usize>>,
    /// Per-thread run fence: a run ends and MCP writes for that run commit under this lock, so
    /// a write either lands inside its run or is refused.
    fences: Mutex<HashMap<ThreadId, Arc<tokio::sync::Mutex<()>>>>,
    pub sessions: Mutex<HashMap<ThreadId, LiveSession>>,
    pub bots: Mutex<Vec<BotProfile>>,
    pub dedupe: Mutex<HashMap<String, commands::DedupeEntry>>,
    pub command_lock: tokio::sync::Mutex<()>,
    pub memory_warned: Mutex<HashSet<(ThreadId, u64)>>,
    /// Sign-in links of open `signin` requests, by request. Memory only (see [SigninLink]).
    signin_links: Mutex<HashMap<RequestId, SigninLink>>,
    engine_groups_hook: Mutex<EngineGroupsNotifier>,
    /// Actor and background tasks, aborted on shutdown so the host (and the store lock) drops.
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
}

/// Called with (snapshot seq, live engine process groups). The seq is assigned under the same
/// lock the groups are read under, so a higher seq is always a later snapshot.
type EngineGroupsHook = Box<dyn Fn(u64, Vec<i32>) + Send + Sync>;

struct EngineGroupsNotifier {
    hook: Option<EngineGroupsHook>,
    seq: u64,
}

/// The host. Cheap to clone.
#[derive(Clone)]
pub struct Host {
    pub(crate) inner: Arc<Inner>,
}

impl Host {
    /// Build the host and settle the previous generation's runs (PRD runtime.md "재시작").
    /// Call [Host::set_mcp_url] before any engine starts, then [Host::start_background].
    pub fn open(
        opts: HostOptions,
        store: Arc<dyn ThreadStore>,
        engine: Arc<dyn EngineFactory>,
        stall: StallRecorder,
    ) -> StoreResult<Self> {
        let (cards_tx, _) = broadcast::channel(1024);
        let host = Self {
            inner: Arc::new(Inner {
                sched: Scheduler::new(opts.max_runs, opts.max_starts),
                opts,
                store,
                engine,
                stall,
                mcp_url: OnceLock::new(),
                cards_tx,
                live: Mutex::new(HashMap::new()),
                actors: Mutex::new(HashMap::new()),
                runtime: Mutex::new(HashMap::new()),
                tokens: Mutex::new(HashMap::new()),
                waiters: Mutex::new(HashMap::new()),
                wait_mode: Mutex::new(HashMap::new()),
                child_reservations: Mutex::new(HashMap::new()),
                fences: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                bots: Mutex::new(Vec::new()),
                dedupe: Mutex::new(HashMap::new()),
                command_lock: tokio::sync::Mutex::new(()),
                memory_warned: Mutex::new(HashSet::new()),
                signin_links: Mutex::new(HashMap::new()),
                engine_groups_hook: Mutex::new(EngineGroupsNotifier { hook: None, seq: 0 }),
                tasks: Mutex::new(Vec::new()),
            }),
        };
        Ok(host)
    }

    /// Called with the live engine process groups whenever they change (`host.json`).
    pub fn on_engine_groups(&self, hook: impl Fn(u64, Vec<i32>) + Send + Sync + 'static) {
        self.inner.engine_groups_hook.lock().expect("hook").hook = Some(Box::new(hook));
    }

    pub(crate) fn engine_groups_changed(&self) {
        // Capture and number the snapshot under one lock (hook lock, then sessions lock).
        let mut notifier = self.inner.engine_groups_hook.lock().expect("hook");
        let groups: Vec<i32> = self
            .inner
            .sessions
            .lock()
            .expect("sessions")
            .values()
            .filter_map(|(_, s)| s.process_group_id())
            .collect();
        notifier.seq += 1;
        let seq = notifier.seq;
        if let Some(hook) = notifier.hook.as_ref() {
            hook(seq, groups);
        }
    }

    pub fn set_mcp_url(&self, url: String) {
        let _ = self.inner.mcp_url.set(url);
    }

    pub fn store(&self) -> &Arc<dyn ThreadStore> {
        &self.inner.store
    }

    pub fn options(&self) -> &HostOptions {
        &self.inner.opts
    }

    /// Settle runs, wake parents, load bots (creating GOAT on first start), resume queues, start
    /// the memory sampler. Must run inside a tokio runtime.
    /// `settled`: threads whose runs the store settled when it opened (`StartupReport.settled`).
    pub async fn start(&self, settled: &[ThreadId]) -> StoreResult<()> {
        let started = Instant::now();
        settle::settle_and_resume(self, settled).await?;
        self.spawn_flusher();
        commands::load_bots(self)?;
        commands::rebuild_dedupe(self).await;
        self.spawn_memory_sampler();
        self.inner.stall.note(
            "startup",
            serde_json::json!({ "ms": started.elapsed().as_millis() as u64, "threads": self.inner.store.cards().len() }),
        );
        Ok(())
    }

    /// Stop every engine process (app quit).
    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self
            .inner
            .sessions
            .lock()
            .expect("sessions")
            .drain()
            .collect();
        for (_, (_, session)) in sessions {
            session.shutdown().await;
        }
        self.engine_groups_changed();
        for task in self.inner.tasks.lock().expect("tasks").drain(..) {
            task.abort();
        }
        self.inner.actors.lock().expect("actors").clear();
        let store = self.inner.store.clone();
        let _ = tokio::task::spawn_blocking(move || store.flush()).await;
    }

    pub(crate) fn fence_lock(&self, id: &ThreadId) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .fences
            .lock()
            .expect("fences")
            .entry(id.clone())
            .or_default()
            .clone()
    }

    pub(crate) fn track(&self, task: &tokio::task::JoinHandle<()>) {
        self.inner
            .tasks
            .lock()
            .expect("tasks")
            .push(task.abort_handle());
    }

    /// The actor mailbox for a thread, spawning the actor if needed. `None` if the thread is
    /// not in the store.
    pub(crate) fn actor(&self, id: &ThreadId) -> Option<mpsc::UnboundedSender<Msg>> {
        let mut actors = self.inner.actors.lock().expect("actors");
        if let Some(tx) = actors.get(id)
            && !tx.is_closed()
        {
            return Some(tx.clone());
        }
        let card = self.inner.store.card(id)?;
        let tx = actor::spawn(self.clone(), card);
        actors.insert(id.clone(), tx.clone());
        Some(tx)
    }

    pub(crate) fn send(&self, id: &ThreadId, msg: Msg) -> bool {
        self.actor(id).is_some_and(|tx| tx.send(msg).is_ok())
    }

    /// Append and broadcast. Every log write goes through here.
    pub(crate) fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended> {
        self.append_with(id, events, false)
    }

    /// Append, flush to disk, then broadcast (the send boundary `run.started`).
    pub(crate) fn append_durable(
        &self,
        id: &ThreadId,
        events: Vec<LogEvent>,
    ) -> StoreResult<Appended> {
        self.append_with(id, events, true)
    }

    fn append_with(
        &self,
        id: &ThreadId,
        events: Vec<LogEvent>,
        durable: bool,
    ) -> StoreResult<Appended> {
        // Lane A syncs send-boundary batches (run.started) before append returns.
        let _ = durable;
        let appended = self.inner.store.append(id, events)?;
        self.publish(id, &appended);
        Ok(appended)
    }

    pub(crate) fn publish(&self, id: &ThreadId, appended: &Appended) {
        if let Some(live) = self.inner.live.lock().expect("live").get(id) {
            for line in &appended.lines {
                let _ = live.tx.send(ThreadLive::Line(Arc::new(line.clone())));
            }
        }
        let _ = self
            .inner
            .cards_tx
            .send(CardUpdate::Changed(Arc::new(appended.card.clone())));
    }

    /// Streaming text for an unfinished item (never stored).
    pub(crate) fn stream_text(&self, id: &ThreadId, item_id: &ItemId, text: &str) {
        let mut live = self.inner.live.lock().expect("live");
        let entry = live.entry(id.clone()).or_insert_with(new_live);
        let offset = match entry.streaming.iter_mut().find(|(i, _)| i == item_id) {
            Some((_, buf)) => {
                let offset = utf16_len(buf);
                buf.push_str(text);
                offset
            }
            None => {
                entry.streaming.push((item_id.clone(), text.to_owned()));
                0
            }
        };
        let _ = entry.tx.send(ThreadLive::Text {
            item_id: item_id.clone(),
            offset,
            text: text.to_owned(),
        });
    }

    pub(crate) fn usage_update(
        &self,
        id: &ThreadId,
        usage: goat2_contracts::ThreadTokenUsageSnapshot,
    ) {
        let mut live = self.inner.live.lock().expect("live");
        let entry = live.entry(id.clone()).or_insert_with(new_live);
        let _ = entry.tx.send(ThreadLive::Usage {
            usage: Box::new(usage),
            updated_at: crate::util::now_rfc3339(),
        });
    }

    pub(crate) fn stream_done(&self, id: &ThreadId, item_id: &ItemId) {
        let mut live = self.inner.live.lock().expect("live");
        if let Some(entry) = live.get_mut(id) {
            entry.streaming.retain(|(i, _)| i != item_id);
            let _ = entry.tx.send(ThreadLive::TextDone {
                item_id: item_id.clone(),
            });
        }
    }

    pub(crate) fn stream_clear(&self, id: &ThreadId) {
        let mut live = self.inner.live.lock().expect("live");
        if let Some(entry) = live.get_mut(id) {
            for (item_id, _) in std::mem::take(&mut entry.streaming) {
                let _ = entry.tx.send(ThreadLive::TextDone { item_id });
            }
        }
    }

    pub(crate) fn watch(
        &self,
        id: &ThreadId,
    ) -> (broadcast::Receiver<ThreadLive>, Vec<StreamingItem>) {
        let mut live = self.inner.live.lock().expect("live");
        let entry = live.entry(id.clone()).or_insert_with(new_live);
        let snapshot = entry
            .streaming
            .iter()
            .map(|(item_id, text)| StreamingItem {
                item_id: item_id.clone(),
                text: text.clone(),
            })
            .collect();
        (entry.tx.subscribe(), snapshot)
    }

    pub(crate) fn runtime_update(&self, id: &ThreadId, f: impl FnOnce(&mut Runtime)) {
        let mut rt = self.inner.runtime.lock().expect("runtime");
        f(rt.entry(id.clone()).or_default());
    }

    pub(crate) fn runtime_of(&self, id: &ThreadId) -> Option<Runtime> {
        self.inner.runtime.lock().expect("runtime").get(id).cloned()
    }

    /// Sign-in links of the open `signin` requests, oldest request id first.
    pub fn signin_links(&self) -> Vec<SigninLink> {
        let links = self.inner.signin_links.lock().expect("signin links");
        let mut out: Vec<SigninLink> = links.values().cloned().collect();
        out.sort_by(|a, b| a.request_id.as_str().cmp(b.request_id.as_str()));
        out
    }

    pub(crate) fn set_signin_link(&self, link: SigninLink) {
        self.inner
            .signin_links
            .lock()
            .expect("signin links")
            .insert(link.request_id.clone(), link);
    }

    pub(crate) fn forget_signin_link(&self, request_id: &RequestId) {
        self.inner
            .signin_links
            .lock()
            .expect("signin links")
            .remove(request_id);
    }

    /// Busy children of a parent (the per-bot child cap counts these).
    pub(crate) fn busy_children(&self, parent: &ThreadId) -> usize {
        self.inner
            .runtime
            .lock()
            .expect("runtime")
            .values()
            .filter(|rt| rt.parent.as_ref() == Some(parent) && rt.busy)
            .count()
    }

    /// Children the given parent run is blocked on (live waits) or started in wait mode.
    pub(crate) fn wait_mode_children(&self, parent_run: &RunId) -> Vec<ThreadId> {
        let mut children: HashSet<ThreadId> = self
            .inner
            .waiters
            .lock()
            .expect("waiters")
            .iter()
            .filter(|(_, ws)| {
                ws.iter()
                    .any(|w| &w.parent_run == parent_run && !w.tx.is_closed())
            })
            .map(|(child, _)| child.clone())
            .collect();
        if let Some(owned) = self
            .inner
            .wait_mode
            .lock()
            .expect("wait_mode")
            .get(parent_run)
        {
            children.extend(owned.iter().cloned());
        }
        children.into_iter().collect()
    }

    pub(crate) fn record_wait_mode(&self, parent_run: &RunId, child: &ThreadId) {
        self.inner
            .wait_mode
            .lock()
            .expect("wait_mode")
            .entry(parent_run.clone())
            .or_default()
            .insert(child.clone());
    }

    pub(crate) fn forget_wait_mode(&self, parent_run: &RunId) {
        self.inner
            .wait_mode
            .lock()
            .expect("wait_mode")
            .remove(parent_run);
    }

    /// Whether a wait call is blocked on this child now (diagnostics and tests).
    pub fn waiting_on(&self, child: &ThreadId) -> bool {
        self.has_live_waiter(child)
    }

    /// A wait call is still blocked on this child.
    pub(crate) fn has_live_waiter(&self, child: &ThreadId) -> bool {
        self.inner
            .waiters
            .lock()
            .expect("waiters")
            .get(child)
            .is_some_and(|ws| ws.iter().any(|w| !w.tx.is_closed()))
    }

    /// Drop waiters whose call already returned (timeout).
    pub(crate) fn prune_waiters(&self, child: &ThreadId) {
        let mut waiters = self.inner.waiters.lock().expect("waiters");
        if let Some(ws) = waiters.get_mut(child) {
            ws.retain(|w| !w.tx.is_closed());
            if ws.is_empty() {
                waiters.remove(child);
            }
        }
    }

    /// Reserve one child slot under the parent's cap, atomically with the busy count. The slot
    /// is released when the guard drops (after the child's first input made it busy).
    pub(crate) fn reserve_child(&self, parent: &ThreadId) -> Option<ChildReservation> {
        let mut reserved = self.inner.child_reservations.lock().expect("reservations");
        let pending = reserved.get(parent).copied().unwrap_or(0);
        if self.busy_children(parent) + pending >= self.inner.opts.max_children {
            return None;
        }
        *reserved.entry(parent.clone()).or_default() += 1;
        Some(ChildReservation {
            host: self.clone(),
            parent: parent.clone(),
        })
    }

    /// Release every waiter of a parent run without a result (Stop / interrupt).
    pub(crate) fn drop_waiters_of(&self, parent_run: &RunId) {
        for ws in self.inner.waiters.lock().expect("waiters").values_mut() {
            ws.retain(|w| &w.parent_run != parent_run);
        }
    }

    pub(crate) fn add_waiter(
        &self,
        child: &ThreadId,
        parent_run: RunId,
    ) -> oneshot::Receiver<ChildOutcome> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .waiters
            .lock()
            .expect("waiters")
            .entry(child.clone())
            .or_default()
            .push(Waiter { parent_run, tx });
        rx
    }

    /// Deliver a child outcome to its waiters. True if a wait received it.
    pub(crate) fn deliver_to_waiters(&self, outcome: &ChildOutcome) -> bool {
        let waiters = self
            .inner
            .waiters
            .lock()
            .expect("waiters")
            .remove(&outcome.child_thread_id)
            .unwrap_or_default();
        let mut delivered = false;
        for w in waiters {
            delivered |= w.tx.send(outcome.clone()).is_ok();
        }
        delivered
    }

    /// Issue a new MCP token for a thread's next engine process and revoke the old ones.
    pub(crate) fn issue_token(&self, id: &ThreadId, process_generation: u64) -> String {
        let token = crate::util::new_token();
        let mut tokens = self.inner.tokens.lock().expect("tokens");
        tokens.retain(|_, g| &g.thread_id != id);
        tokens.insert(
            token.clone(),
            McpGrant {
                thread_id: id.clone(),
                process_generation,
                host_generation: self.inner.opts.host_generation,
            },
        );
        token
    }

    pub(crate) fn revoke_tokens(&self, id: &ThreadId) {
        self.inner
            .tokens
            .lock()
            .expect("tokens")
            .retain(|_, g| &g.thread_id != id);
    }

    pub(crate) fn bot(&self, id: &BotId) -> Option<BotProfile> {
        self.inner
            .bots
            .lock()
            .expect("bots")
            .iter()
            .find(|b| &b.bot_id == id)
            .cloned()
    }

    /// Lane A batches in-run card writes until `flush`.
    fn spawn_flusher(&self) {
        let host = self.clone();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            loop {
                tick.tick().await;
                let store = host.inner.store.clone();
                if let Ok(Err(err)) = tokio::task::spawn_blocking(move || store.flush()).await {
                    tracing::warn!(%err, "card flush failed");
                }
            }
        });
        self.track(&task);
    }

    fn spawn_memory_sampler(&self) {
        let host = self.clone();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(host.inner.opts.memory_sample);
            tick.tick().await;
            loop {
                tick.tick().await;
                host.sample_memory();
            }
        });
        self.track(&task);
    }

    /// Sample every live engine group once (idle-stopped processes have no session).
    pub fn sample_memory(&self) {
        let limit = self.inner.opts.memory_limit_bytes;
        let sessions: Vec<_> = self
            .inner
            .sessions
            .lock()
            .expect("sessions")
            .iter()
            .map(|(id, (pgen, s))| (id.clone(), *pgen, s.clone()))
            .collect();
        for (id, pgen, session) in sessions {
            let Some(bytes) = session.group_rss_bytes() else {
                continue;
            };
            if bytes > limit {
                self.send(&id, Msg::MemoryLimit { pgen, bytes });
            } else if bytes * 100 >= limit * u64::from(ENGINE_MEMORY_WARN_PERCENT)
                && self
                    .inner
                    .memory_warned
                    .lock()
                    .expect("warned")
                    .insert((id.clone(), pgen))
            {
                self.inner.stall.note(
                    "memory_warning",
                    serde_json::json!({ "thread": id, "rssBytes": bytes, "limitBytes": limit }),
                );
            }
        }
    }
}

/// A reserved child slot; see [Host::reserve_child].
pub(crate) struct ChildReservation {
    host: Host,
    parent: ThreadId,
}

impl Drop for ChildReservation {
    fn drop(&mut self) {
        let mut reserved = self
            .host
            .inner
            .child_reservations
            .lock()
            .expect("reservations");
        if let Some(n) = reserved.get_mut(&self.parent) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                reserved.remove(&self.parent);
            }
        }
    }
}

fn new_live() -> LiveThread {
    LiveThread {
        tx: broadcast::channel(1024).0,
        streaming: Vec::new(),
    }
}

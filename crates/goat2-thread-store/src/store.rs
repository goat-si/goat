//! The store: thread folders, card index, reads and startup.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Instant;

use serde::Serialize;

use crate::blob;
use crate::contract::*;
use crate::error::{Result, StoreError};
use crate::fold;
use crate::fsutil::{
    atomic_write, new_uuid, now_rfc3339, random_hex, sync_dir, validate_thread_id,
};
use crate::index::{self, INDEX_FILE, Index, RebuildReason};
use crate::line::{self, Parsed};
use crate::log::{self, LOG_FILE, Repair, Tail, TailError};

const THREADS_DIR: &str = "threads";
const CARD_FILE: &str = "card.json";
const LOCK_FILE: &str = "store.lock";
const SUB_CAPACITY: usize = 1024;
const PAGE_MAX: u32 = 512;
const HINT_EVERY: u64 = 64;

/// Store settings.
#[derive(Debug, Clone)]
pub struct StoreOptions {
    /// Sync files, directories and index commits at the points DESIGN.md names. Turn off only for
    /// generated fixtures.
    pub fsync: bool,
    /// Injected failures for crash and I/O tests. Not for production use.
    #[doc(hidden)]
    pub faults: Faults,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            fsync: true,
            faults: Faults::default(),
        }
    }
}

/// Test-only fault switches (see `testing::set_faults`).
#[doc(hidden)]
#[derive(Debug, Clone, Copy, Default)]
pub struct Faults {
    /// Opening or probing a thread's log or folder fails with an I/O error.
    pub fail_log_reads: bool,
    /// Syncing a thread's log fails with an I/O error.
    pub fail_log_syncs: bool,
    /// An index rebuild stops (returns an error) before it writes its rows.
    pub stop_rebuild_before_rows: bool,
    /// Writing card.json fails with an I/O error.
    pub fail_cache_writes: bool,
}

fn injected(what: &str) -> std::io::Error {
    std::io::Error::other(format!("injected fault: {what}"))
}

/// What `Store::open` did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    pub threads: usize,
    pub index: IndexOutcome,
    /// `goat.jsonl` files opened during startup. 0 for a clean start.
    pub logs_opened: u64,
    pub refolded: Vec<String>,
    pub settled: Vec<Settled>,
    pub repaired: Vec<Repaired>,
    pub abandoned_creates: Vec<String>,
    pub removed_deleted: Vec<String>,
    pub corrupt: Vec<Problem>,
    pub unsupported: Vec<Problem>,
    /// Folders an index rebuild could not index (the index stays incomplete).
    pub unindexed: Vec<Problem>,
    pub timings: StartupTimings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum IndexOutcome {
    Loaded,
    Rebuilt { reason: String, complete: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settled {
    pub thread_id: String,
    pub run_id: String,
    pub outcome: RunOutcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repaired {
    pub thread_id: String,
    pub repair: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub thread_id: String,
    pub detail: String,
}

/// Milliseconds per startup phase.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupTimings {
    pub lock_ms: f64,
    pub index_open_ms: f64,
    pub load_ms: f64,
    pub rebuild_ms: f64,
    pub recover_ms: f64,
    pub settle_ms: f64,
    pub total_ms: f64,
}

/// Result of `append`.
#[derive(Debug, Clone)]
pub struct Appended {
    pub lines: Vec<LogLine>,
    pub card: ThreadCard,
    /// The fold after these lines.
    pub fold: Fold,
}

/// State a reader starts from.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// The log seq this state includes.
    pub seq: u64,
    pub card: ThreadCard,
    pub fold: Fold,
    /// True when taken from a checkpoint line, false when built from the current state.
    pub from_checkpoint: bool,
}

/// Result of `read`.
#[derive(Debug, Clone)]
pub struct ThreadRead {
    pub reset: Option<ResetReason>,
    pub snapshot: Option<Snapshot>,
    /// Contiguous lines ending at the head, after the snapshot (or the cursor).
    pub lines: Vec<LogLine>,
    /// `(epoch, head)`; absent when the thread is missing.
    pub cursor: Option<ThreadCursor>,
}

/// Result of `read_page`: oldest first.
#[derive(Debug, Clone)]
pub struct Page {
    pub lines: Vec<LogLine>,
    pub has_more: bool,
}

/// Result of `cards_after`.
#[derive(Debug, Clone)]
pub struct CardsRead {
    pub reset: Option<ResetReason>,
    pub cards: Vec<ThreadCard>,
    pub cursor: CardCursor,
}

/// Live card subscription message.
#[derive(Debug, Clone)]
pub enum CardUpdate {
    Changed(Box<ThreadCard>),
    Removed { thread_id: ThreadId, card_seq: u64 },
}

/// Live thread subscription message: lines appended after the replay.
#[derive(Debug, Clone)]
pub struct ThreadUpdate {
    pub lines: Vec<LogLine>,
}

/// Card lookup by index fields. Unset fields match everything.
#[derive(Debug, Clone, Default)]
pub struct CardFilter {
    pub cwd: Option<String>,
    pub parent_thread_id: Option<ThreadId>,
    pub status: Option<ThreadStatus>,
    pub kind: Option<ThreadKind>,
    pub bot_id: Option<BotId>,
    pub project_id: Option<ProjectId>,
    pub archived: Option<bool>,
}

impl CardFilter {
    fn matches(&self, card: &ThreadCard) -> bool {
        self.cwd.as_ref().is_none_or(|c| &card.engine.cwd == c)
            && self
                .parent_thread_id
                .as_ref()
                .is_none_or(|p| card.parent.as_ref().is_some_and(|x| &x.thread_id == p))
            && self.status.is_none_or(|s| card.status == s)
            && self.kind.is_none_or(|k| card.kind == k)
            && self
                .bot_id
                .as_ref()
                .is_none_or(|b| card.bot_id.as_ref() == Some(b))
            && self
                .project_id
                .as_ref()
                .is_none_or(|p| card.project_id.as_ref() == Some(p))
            && self
                .archived
                .is_none_or(|a| card.archived_at.is_some() == a)
    }
}

#[derive(Debug, Clone)]
enum Health {
    /// Loaded from the index; the log tail has not been checked in this process.
    Unverified,
    Ready,
    Unsupported {
        seq: u64,
        v: u64,
        kind: String,
    },
    Corrupt(String),
    Poisoned(String),
    /// Deleted while another caller waited for this thread's lock; the id may already belong to a
    /// new thread with its own slot.
    Deleted,
}

struct Slot {
    id: ThreadId,
    dir: PathBuf,
    card: ThreadCard,
    fold: Fold,
    health: Health,
    header_end: u64,
    len: u64,
    synced_len: u64,
    writer: Option<File>,
    /// The index row's dirty mark is durably 1.
    durable_dirty: bool,
    /// card.json / index row lag the in-memory card.
    stale: bool,
    /// Last failed card.json / index write, if the cache is behind because of it.
    cache_error: Option<String>,
    /// seq -> line start offset, every [HINT_EVERY] lines seen.
    hints: BTreeMap<u64, u64>,
    subs: Vec<SyncSender<ThreadUpdate>>,
}

impl Slot {
    fn log_path(&self) -> PathBuf {
        self.dir.join(LOG_FILE)
    }

    fn check_health(&self) -> Result<()> {
        match &self.health {
            Health::Ready | Health::Unverified => Ok(()),
            Health::Unsupported { seq, v, kind } => Err(StoreError::UnsupportedEvent {
                thread: self.id.to_string(),
                seq: *seq,
                kind: kind.clone(),
                v: *v,
            }),
            Health::Corrupt(detail) => Err(StoreError::CorruptLog {
                thread: self.id.to_string(),
                detail: detail.clone(),
            }),
            Health::Poisoned(detail) => Err(StoreError::Poisoned {
                thread: self.id.to_string(),
                detail: detail.clone(),
            }),
            Health::Deleted => Err(StoreError::ThreadMissing(self.id.to_string())),
        }
    }

    fn is_deleted(&self) -> bool {
        matches!(self.health, Health::Deleted)
    }
}

struct Shared {
    index: Index,
    epoch: Epoch,
    next_card_seq: u64,
    cards: HashMap<ThreadId, ThreadCard>,
    /// cardSeq of the latest deletion in this process (0: none). A cursor before it is reset.
    last_deletion_seq: u64,
    subs: Vec<SyncSender<CardUpdate>>,
}

impl Shared {
    fn publish(&mut self, card: &mut ThreadCard) {
        self.assign_seq(card);
        self.announce(card);
    }

    fn assign_seq(&mut self, card: &mut ThreadCard) {
        card.card_seq = self.next_card_seq;
        self.next_card_seq += 1;
    }

    /// Put the card in the card set and tell card subscribers.
    fn announce(&mut self, card: &ThreadCard) {
        self.cards.insert(card.id.clone(), card.clone());
        let update = CardUpdate::Changed(Box::new(card.clone()));
        self.subs.retain(|tx| {
            !matches!(
                tx.try_send(update.clone()),
                Err(TrySendError::Full(_) | TrySendError::Disconnected(_))
            )
        });
    }

    fn max_card_seq(&self) -> u64 {
        self.next_card_seq - 1
    }
}

/// The per-thread folder store. See DESIGN.md.
pub struct Store {
    root: PathBuf,
    opts: StoreOptions,
    _lock: File,
    slots: RwLock<HashMap<ThreadId, Arc<Mutex<Slot>>>>,
    shared: Mutex<Shared>,
    crashed: std::sync::atomic::AtomicBool,
    logs_opened: std::sync::atomic::AtomicU64,
    faults: Mutex<Faults>,
    index_complete: std::sync::atomic::AtomicBool,
    /// Test hook: `create_thread` waits on both barriers right before it announces the card.
    create_pause: Mutex<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>>,
    /// Test hook: `delete_thread` waits on barriers 0,1 after taking the thread lock and on 2,3
    /// after removing the thread from the map, still holding the lock.
    delete_pause: Mutex<Option<[Arc<std::sync::Barrier>; 4]>>,
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn tail_problem(err: TailError) -> std::result::Result<String, StoreError> {
    match err {
        TailError::Io(e) => Err(e.into()),
        TailError::Missing => Ok("goat.jsonl is missing".into()),
        TailError::BadHeader(d) => Ok(format!("header: {d}")),
        TailError::Corrupt(d) => Ok(d),
    }
}

fn tail_error(id: &ThreadId, err: TailError) -> StoreError {
    match tail_problem(err) {
        Ok(detail) => StoreError::CorruptLog {
            thread: id.to_string(),
            detail,
        },
        Err(io) => io,
    }
}

fn repair_text(repair: &Repair) -> String {
    match repair {
        Repair::Truncated { bytes, saved_to } => {
            format!(
                "cut {bytes} incomplete bytes, saved to {}",
                saved_to.display()
            )
        }
        Repair::NewlineAdded => "added the missing newline after the last line".into(),
    }
}

fn card_doc(card: &ThreadCard, fold: &Fold) -> Result<String> {
    Ok(serde_json::to_string(&CardFile::new(
        card.clone(),
        fold.clone(),
    ))?)
}

/// card.json of a folder: `Ok(None)` when it is missing or not a valid v1 card file (a cache miss);
/// other I/O errors propagate.
fn read_card_file(dir: &Path) -> Result<Option<CardFile>> {
    let bytes = match fs::read(dir.join(CARD_FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok(std::str::from_utf8(&bytes).ok().and_then(index::decode_doc))
}

impl Store {
    /// Open (or create) a store at `root`. Takes an exclusive lock, loads the card index (or
    /// rebuilds it from the folders), recovers dirty / active threads and settles runs that were
    /// active when the previous process ended.
    pub fn open(root: impl AsRef<Path>, opts: StoreOptions) -> Result<(Store, StartupReport)> {
        let t_total = Instant::now();
        let root = root.as_ref().to_path_buf();
        let mut timings = StartupTimings::default();
        let t = Instant::now();
        fs::create_dir_all(root.join(THREADS_DIR))?;
        let lock_file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(root.join(LOCK_FILE))?;
        match lock_file.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(StoreError::Locked),
            Err(fs::TryLockError::Error(e)) => return Err(e.into()),
        }
        timings.lock_ms = ms(t);

        let t = Instant::now();
        let (index, rebuild) = Index::open(&root.join(INDEX_FILE), opts.fsync)?;
        timings.index_open_ms = ms(t);

        let epoch = Epoch::new(new_uuid());
        index.set_meta("epoch", epoch.as_str())?;
        let initial_faults = opts.faults;
        let store = Store {
            root,
            opts,
            _lock: lock_file,
            slots: RwLock::new(HashMap::new()),
            shared: Mutex::new(Shared {
                index,
                epoch,
                next_card_seq: 1,
                cards: HashMap::new(),
                last_deletion_seq: 0,
                subs: Vec::new(),
            }),
            crashed: std::sync::atomic::AtomicBool::new(false),
            logs_opened: std::sync::atomic::AtomicU64::new(0),
            faults: Mutex::new(initial_faults),
            index_complete: std::sync::atomic::AtomicBool::new(true),
            create_pause: Mutex::new(None),
            delete_pause: Mutex::new(None),
        };
        let mut report = StartupReport {
            threads: 0,
            index: IndexOutcome::Loaded,
            logs_opened: 0,
            refolded: Vec::new(),
            settled: Vec::new(),
            repaired: Vec::new(),
            abandoned_creates: Vec::new(),
            removed_deleted: Vec::new(),
            corrupt: Vec::new(),
            unsupported: Vec::new(),
            unindexed: Vec::new(),
            timings: StartupTimings::default(),
        };

        let mut to_recover: Vec<ThreadId> = Vec::new();
        match rebuild {
            Some(reason) => {
                let t = Instant::now();
                let complete = store.rebuild_from_folders(&mut report)?;
                report.index = IndexOutcome::Rebuilt {
                    reason: reason.to_string(),
                    complete,
                };
                timings.rebuild_ms = ms(t);
            }
            None => {
                let t = Instant::now();
                let rows = {
                    let shared = lock(&store.shared);
                    match shared.index.load_all() {
                        Ok(rows) => Ok(rows),
                        Err(e) if index::is_corruption(&e) => {
                            Err(RebuildReason::Corrupt(e.to_string()))
                        }
                        Err(e) => return Err(e.into()),
                    }
                };
                match rows {
                    Ok(rows) => {
                        for row in rows {
                            store.load_row(row, &mut to_recover, &mut report)?;
                        }
                        timings.load_ms = ms(t);
                    }
                    Err(reason) => {
                        // Corruption found while reading rows: recreate and rebuild.
                        let t = Instant::now();
                        {
                            let mut shared = lock(&store.shared);
                            let path = store.root.join(INDEX_FILE);
                            shared.index.recreate(&path)?;
                            let epoch = shared.epoch.clone();
                            shared.index.set_meta("epoch", epoch.as_str())?;
                        }
                        lock(&store.shared).cards.clear();
                        store
                            .slots
                            .write()
                            .unwrap_or_else(|p| p.into_inner())
                            .clear();
                        to_recover.clear();
                        let complete = store.rebuild_from_folders(&mut report)?;
                        report.index = IndexOutcome::Rebuilt {
                            reason: reason.to_string(),
                            complete,
                        };
                        timings.rebuild_ms = ms(t);
                    }
                }
            }
        }

        let t = Instant::now();
        for id in to_recover {
            store.recover_startup(&id, &mut report)?;
        }
        timings.recover_ms = ms(t);

        let t = Instant::now();
        let active: Vec<Arc<Mutex<Slot>>> = store
            .slots
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        for slot in active {
            let mut slot = lock(&slot);
            if !matches!(slot.health, Health::Ready) {
                continue;
            }
            let Some(run_id) = slot.fold.active_run_id.clone() else {
                continue;
            };
            let outcome = if slot.fold.active_run_reached_engine {
                RunOutcome::Interrupted
            } else {
                RunOutcome::Unknown
            };
            // v1 ProviderRuntimeRecoveryService.ts:370 expires requests the dead run was waiting on;
            // here they resolve as cancelled before the run is settled.
            let mut events: Vec<LogEvent> = slot
                .fold
                .open_requests
                .iter()
                .filter(|r| r.run_id.as_ref() == Some(&run_id) && r.kind != RequestKind::Resend)
                .map(|r| {
                    LogEvent::RequestResolved(RequestResolved {
                        request_id: r.request_id.clone(),
                        outcome: RequestOutcome::Cancel,
                        option_id: None,
                        text: Some("The host restarted before this request was answered.".into()),
                        answers: None,
                    })
                })
                .collect();
            events.push(LogEvent::RunFinished(RunFinished {
                run_id: run_id.clone(),
                outcome,
                reason: Some("The host restarted before the run finished.".into()),
            }));
            store.append_locked(&mut slot, events)?;
            report.settled.push(Settled {
                thread_id: slot.id.to_string(),
                run_id: run_id.to_string(),
                outcome,
            });
        }
        timings.settle_ms = ms(t);

        report.threads = lock(&store.shared).cards.len();
        report.logs_opened = store.logs_opened.load(std::sync::atomic::Ordering::Relaxed);
        timings.total_ms = ms(t_total);
        report.timings = timings;
        Ok((store, report))
    }

    fn threads_dir(&self) -> PathBuf {
        self.root.join(THREADS_DIR)
    }

    fn thread_dir(&self, id: &ThreadId) -> PathBuf {
        self.threads_dir().join(id.as_str())
    }

    fn faults(&self) -> Faults {
        *lock(&self.faults)
    }

    /// Open a log for reading (honours injected read faults).
    fn open_log_read(&self, path: &Path) -> std::io::Result<File> {
        if self.faults().fail_log_reads {
            return Err(injected("log read"));
        }
        log::open_read(path)
    }

    fn sync_file(&self, file: &File) -> std::io::Result<()> {
        if self.faults().fail_log_syncs {
            return Err(injected("log sync"));
        }
        file.sync_data()
    }

    /// False when the last index rebuild could not index every folder: the card list is degraded
    /// until a later start rebuilds it completely.
    pub fn index_complete(&self) -> bool {
        self.index_complete
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    fn new_slot(&self, id: ThreadId, card: ThreadCard, fold: Fold, health: Health) -> Slot {
        Slot {
            dir: self.thread_dir(&id),
            id,
            card,
            fold,
            health,
            header_end: 0,
            len: 0,
            synced_len: 0,
            writer: None,
            durable_dirty: false,
            stale: false,
            cache_error: None,
            hints: BTreeMap::new(),
            subs: Vec::new(),
        }
    }

    fn insert_slot(&self, slot: Slot) {
        let id = slot.id.clone();
        let mut card = slot.card.clone();
        {
            let mut shared = lock(&self.shared);
            if card.card_seq == 0 || card.card_seq >= shared.next_card_seq {
                // Cards keep their stored cardSeq; new or out-of-range ones get the next one.
                shared.publish(&mut card);
            } else {
                shared.cards.insert(id.clone(), card.clone());
            }
            shared.next_card_seq = shared.next_card_seq.max(card.card_seq + 1);
        }
        let mut slot = slot;
        slot.card.card_seq = card.card_seq;
        self.slots
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, Arc::new(Mutex::new(slot)));
    }

    fn load_row(
        &self,
        row: index::Row,
        to_recover: &mut Vec<ThreadId>,
        report: &mut StartupReport,
    ) -> Result<()> {
        let id = ThreadId::new(row.id.clone());
        let needs_check = row.dirty || row.creating || row.active_run;
        let doc = row.doc.as_deref().and_then(index::decode_doc);
        match doc {
            Some(file) if !needs_check => {
                self.insert_slot(self.new_slot(id, file.card, file.fold, Health::Unverified));
            }
            Some(file) => {
                let mut slot = self.new_slot(id.clone(), file.card, file.fold, Health::Unverified);
                slot.durable_dirty = row.dirty;
                self.insert_slot(slot);
                to_recover.push(id);
            }
            None => {
                // No usable cached card: a create in progress, or a row to rebuild from the folder.
                let dir = self.thread_dir(&id);
                let log_path = dir.join(LOG_FILE);
                let dir_meta = self.probe(&dir)?;
                let log_meta = match dir_meta {
                    Some(_) => self.probe(&log_path)?,
                    None => None,
                };
                if row.creating {
                    // Abandon only a create that provably never committed its one log write.
                    let committed = log_meta.is_some() && self.create_committed(&log_path)?;
                    if !committed {
                        self.abandon_create(&id)?;
                        report.abandoned_creates.push(row.id);
                        return Ok(());
                    }
                } else if dir_meta.is_none() {
                    lock(&self.shared).index.delete(id.as_str())?;
                    report.removed_deleted.push(row.id);
                    return Ok(());
                } else if log_meta.is_none() {
                    report.corrupt.push(Problem {
                        thread_id: row.id,
                        detail: "goat.jsonl is missing".into(),
                    });
                    return Ok(());
                }
                match self.replay_folder(&id) {
                    Ok(Some((card, fold, health))) => {
                        let mut slot = self.new_slot(id.clone(), card, fold, Health::Unverified);
                        slot.health = health;
                        slot.durable_dirty = row.dirty;
                        self.insert_slot(slot);
                        to_recover.push(id);
                    }
                    Ok(None) => report.corrupt.push(Problem {
                        thread_id: row.id,
                        detail: "no thread.created line".into(),
                    }),
                    Err(StoreError::CorruptLog { detail, .. }) => report.corrupt.push(Problem {
                        thread_id: row.id,
                        detail,
                    }),
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(())
    }

    /// Metadata of `path`: `None` when it does not exist; any other error propagates.
    fn probe(&self, path: &Path) -> Result<Option<fs::Metadata>> {
        if self.faults().fail_log_reads {
            return Err(StoreError::Io(injected("probe")));
        }
        match fs::symlink_metadata(path) {
            Ok(meta) => Ok(Some(meta)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// True when the log holds a newline-terminated first event line: `create_thread` writes the
    /// header and `thread.created` in one write, so anything less never committed.
    fn create_committed(&self, path: &Path) -> Result<bool> {
        use std::io::Read;
        let mut file = self.open_log_read(path)?;
        let mut buf = [0u8; 64 * 1024];
        let mut newlines = 0;
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                return Ok(false);
            }
            newlines += buf[..n].iter().filter(|&&b| b == b'\n').count();
            if newlines >= 2 {
                return Ok(true);
            }
        }
    }

    fn abandon_create(&self, id: &ThreadId) -> Result<()> {
        let dir = self.thread_dir(id);
        if self.probe(&dir)?.is_some() {
            let trash =
                self.threads_dir()
                    .join(format!(".trash-{}-{}", id.as_str(), random_hex(8)));
            fs::rename(&dir, &trash)?;
            let _ = fs::remove_dir_all(&trash);
        }
        lock(&self.shared).index.delete(id.as_str())?;
        Ok(())
    }

    /// Read a whole log and fold it. `Ok(None)` when the log has no `thread.created` at seq 1.
    fn replay_folder(&self, id: &ThreadId) -> Result<Option<(ThreadCard, Fold, Health)>> {
        let path = self.thread_dir(id).join(LOG_FILE);
        self.logs_opened
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.faults().fail_log_reads {
            return Err(StoreError::Io(injected("log read")));
        }
        // Repair an incomplete tail first so a torn last write does not hide the thread.
        let tail = log::verify_tail(&path, self.opts.fsync).map_err(|e| tail_error(id, e))?;
        let file = self.open_log_read(&path)?;
        let len = tail.len;
        let (header, header_end) = log::read_header(&file, len).map_err(|e| tail_error(id, e))?;
        let mut state: Option<(ThreadCard, Fold)> = None;
        let mut health = Health::Ready;
        let mut expected = 1u64;
        log::scan_forward(&file, header_end, len, |_, bytes| -> Result<bool> {
            if bytes.is_empty() || bytes.iter().all(|&b| b == 0) {
                // verify_tail already cut a trailing incomplete fragment, so this line is interior.
                return Err(StoreError::CorruptLog {
                    thread: id.to_string(),
                    detail: format!("empty or zero-filled line where seq {expected} should be"),
                });
            }
            let parsed = line::decode(bytes).map_err(|detail| StoreError::CorruptLog {
                thread: id.to_string(),
                detail,
            })?;
            if parsed.seq() != expected {
                return Err(StoreError::CorruptLog {
                    thread: id.to_string(),
                    detail: format!("expected seq {expected}, found {}", parsed.seq()),
                });
            }
            expected += 1;
            match (parsed, &mut state) {
                (Parsed::Event(line), None) => match &line.event {
                    LogEvent::ThreadCreated(created) => {
                        state = Some(fold::initial(
                            id,
                            created,
                            &header.epoch,
                            line.seq,
                            &line.at,
                        ));
                        Ok(true)
                    }
                    _ => Ok(false),
                },
                (Parsed::Event(line), Some((card, f))) => {
                    fold::apply(card, f, &line);
                    Ok(true)
                }
                (Parsed::Skip { seq, .. }, Some((card, _))) => {
                    card.applied_seq = seq;
                    Ok(true)
                }
                (Parsed::Unsupported { seq, v, kind }, Some(_)) => {
                    health = Health::Unsupported { seq, v, kind };
                    Ok(false)
                }
                (_, None) => Ok(false),
            }
        })?;
        Ok(state.map(|(card, fold)| (card, fold, health)))
    }

    /// Rebuild the card index from the folders. Returns whether every folder was indexed; only then
    /// is the completion marker written with the rows, so an interrupted or partial rebuild is
    /// redone at the next start. I/O errors fail `open`; corrupt folders are kept and reported.
    fn rebuild_from_folders(&self, report: &mut StartupReport) -> Result<bool> {
        let mut complete = true;
        let mut built: Vec<ThreadId> = Vec::new();
        let mut entries: Vec<_> =
            fs::read_dir(self.threads_dir())?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with(".trash-") {
                let _ = fs::remove_dir_all(entry.path());
                continue;
            }
            if name.starts_with('.')
                || !entry.file_type()?.is_dir()
                || validate_thread_id(name).is_err()
            {
                continue;
            }
            let id = ThreadId::new(name);
            let mut unindexed = |detail: String| {
                complete = false;
                report.unindexed.push(Problem {
                    thread_id: id.to_string(),
                    detail,
                });
            };
            if self.faults().fail_log_reads {
                return Err(StoreError::Io(injected("log read")));
            }
            self.logs_opened
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let tail = match log::verify_tail(&entry.path().join(LOG_FILE), self.opts.fsync) {
                Ok(tail) => tail,
                Err(TailError::Io(e)) => return Err(e.into()),
                Err(e) => {
                    unindexed(tail_problem(e)?);
                    continue;
                }
            };
            if let Some(repair) = &tail.repair {
                report.repaired.push(Repaired {
                    thread_id: id.to_string(),
                    repair: repair_text(repair),
                });
            }
            let cached = read_card_file(&entry.path())?.filter(|f| {
                f.card.id == id
                    && f.card.epoch == tail.epoch
                    && f.card.applied_seq <= tail.last_seq()
            });
            let mut slot = match cached {
                Some(file) => {
                    let mut slot =
                        self.new_slot(id.clone(), file.card, file.fold, Health::Unverified);
                    match self.apply_tail(&mut slot, &tail) {
                        Ok(()) => slot,
                        Err(StoreError::CorruptLog { detail, .. }) => {
                            unindexed(detail);
                            continue;
                        }
                        Err(e) => return Err(e),
                    }
                }
                None => match self.replay_folder(&id) {
                    Ok(Some((card, fold, health))) => {
                        report.refolded.push(id.to_string());
                        let mut slot = self.new_slot(id.clone(), card, fold, health);
                        slot.header_end = tail.header_end;
                        slot.len = tail.len;
                        slot.synced_len = 0;
                        slot
                    }
                    Ok(None) => {
                        unindexed("no thread.created line".into());
                        continue;
                    }
                    Err(StoreError::CorruptLog { detail, .. }) => {
                        unindexed(detail);
                        continue;
                    }
                    Err(e) => return Err(e),
                },
            };
            // The tail seen here may not be durable yet: sync it before its row is stored.
            self.sync_log(&mut slot)?;
            built.push(id.clone());
            self.insert_slot(slot);
        }
        let mut writes: Vec<(ThreadCard, bool, String)> = Vec::new();
        {
            let slots = self.slots.read().unwrap_or_else(|p| p.into_inner());
            for id in &built {
                if let Some(slot) = slots.get(id) {
                    let slot = lock(slot);
                    let active = slot.fold.active_run_id.is_some();
                    writes.push((slot.card.clone(), active, card_doc(&slot.card, &slot.fold)?));
                }
            }
        }
        if self.faults().stop_rebuild_before_rows {
            return Err(StoreError::Io(injected("rebuild stopped before rows")));
        }
        let refs: Vec<(&ThreadCard, bool, bool, String)> = writes
            .iter()
            .map(|(c, active, doc)| (c, *active, *active, doc.clone()))
            .collect();
        lock(&self.shared).index.finish_rebuild(&refs, complete)?;
        self.index_complete
            .store(complete, std::sync::atomic::Ordering::Relaxed);
        Ok(complete)
    }

    /// Startup recovery for a row marked dirty / creating / active.
    fn recover_startup(&self, id: &ThreadId, report: &mut StartupReport) -> Result<()> {
        let Some(slot) = self.slot(id) else {
            return Ok(());
        };
        let mut slot = lock(&slot);
        if self.probe(&slot.dir)?.is_none() {
            // Deleted (row marked dirty before the folder moved to trash) or never created.
            drop(slot);
            self.slots
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .remove(id);
            let mut shared = lock(&self.shared);
            shared.cards.remove(id);
            shared.index.delete(id.as_str())?;
            report.removed_deleted.push(id.to_string());
            return Ok(());
        }
        // Prefer card.json when it is newer than the index row.
        if let Some(file) = read_card_file(&slot.dir)?
            && file.card.id == *id
            && file.card.epoch == slot.card.epoch
            && file.card.applied_seq > slot.card.applied_seq
        {
            let card_seq = slot.card.card_seq;
            slot.card = file.card;
            slot.card.card_seq = card_seq;
            slot.fold = file.fold;
        }
        let before = slot.card.applied_seq;
        match self.verify_and_refold(&mut slot, report) {
            Ok(()) => {
                if slot.card.applied_seq != before {
                    report.refolded.push(id.to_string());
                }
                if let Health::Unsupported { seq, v, kind } = &slot.health {
                    report.unsupported.push(Problem {
                        thread_id: id.to_string(),
                        detail: format!("line {seq}: type {kind:?} v {v}"),
                    });
                }
                if slot.fold.active_run_id.is_some() && matches!(slot.health, Health::Ready) {
                    // Settlement appends and persists this thread right after recovery.
                    slot.stale = true;
                } else {
                    self.persist(&mut slot)?;
                }
            }
            Err(StoreError::CorruptLog { detail, .. }) => {
                slot.health = Health::Corrupt(detail.clone());
                report.corrupt.push(Problem {
                    thread_id: id.to_string(),
                    detail,
                });
            }
            Err(e) => return Err(e),
        }
        Ok(())
    }

    /// Verify the log tail (repairing an incomplete tail) and fold lines after `appliedSeq`.
    fn verify_and_refold(&self, slot: &mut Slot, report: &mut StartupReport) -> Result<()> {
        self.logs_opened
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.faults().fail_log_reads {
            return Err(StoreError::Io(injected("log read")));
        }
        let tail = match log::verify_tail(&slot.log_path(), self.opts.fsync) {
            Ok(tail) => tail,
            Err(e) => {
                let detail = tail_problem(e)?;
                return Err(StoreError::CorruptLog {
                    thread: slot.id.to_string(),
                    detail,
                });
            }
        };
        if let Some(repair) = &tail.repair {
            report.repaired.push(Repaired {
                thread_id: slot.id.to_string(),
                repair: repair_text(repair),
            });
        }
        self.apply_tail(slot, &tail)
    }

    fn apply_tail(&self, slot: &mut Slot, tail: &Tail) -> Result<()> {
        slot.header_end = tail.header_end;
        slot.len = tail.len;
        // What was read may not be durable yet (written by a process that crashed before syncing).
        slot.synced_len = if self.opts.fsync { 0 } else { tail.len };
        let last_seq = tail.last_seq();
        if tail.epoch != slot.card.epoch || last_seq < slot.card.applied_seq {
            // The cache does not belong to this log: replay the whole log.
            match self.replay_folder(&slot.id)? {
                Some((card, fold, health)) => {
                    let card_seq = slot.card.card_seq;
                    slot.card = card;
                    slot.card.card_seq = card_seq;
                    slot.fold = fold;
                    slot.health = health;
                    return Ok(());
                }
                None => {
                    return Err(StoreError::CorruptLog {
                        thread: slot.id.to_string(),
                        detail: "no thread.created line".into(),
                    });
                }
            }
        }
        if last_seq > slot.card.applied_seq {
            self.fold_after(slot)?;
        } else {
            slot.health = Health::Ready;
        }
        Ok(())
    }

    /// Fold the lines after `appliedSeq` (read backwards from the end, applied in order).
    fn fold_after(&self, slot: &mut Slot) -> Result<()> {
        let file = self.open_log_read(&slot.log_path())?;
        let after = slot.card.applied_seq;
        let mut lines: Vec<Parsed> = Vec::new();
        let id = slot.id.to_string();
        log::scan_back(
            &file,
            slot.header_end,
            slot.len,
            |_, bytes| -> Result<bool> {
                let parsed = line::decode(bytes).map_err(|detail| StoreError::CorruptLog {
                    thread: id.clone(),
                    detail,
                })?;
                if parsed.seq() <= after {
                    return Ok(false);
                }
                lines.push(parsed);
                Ok(true)
            },
        )?;
        lines.reverse();
        slot.health = Health::Ready;
        for (expected, parsed) in (after + 1..).zip(lines) {
            if parsed.seq() != expected {
                return Err(StoreError::CorruptLog {
                    thread: id,
                    detail: format!("expected seq {expected}, found {}", parsed.seq()),
                });
            }
            match parsed {
                Parsed::Event(line) => fold::apply(&mut slot.card, &mut slot.fold, &line),
                Parsed::Skip { seq, .. } => slot.card.applied_seq = seq,
                Parsed::Unsupported { seq, v, kind } => {
                    slot.health = Health::Unsupported { seq, v, kind };
                    break;
                }
            }
        }
        Ok(())
    }

    fn slot(&self, id: &ThreadId) -> Option<Arc<Mutex<Slot>>> {
        self.slots
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    /// First touch in this process: verify the tail and catch up the card.
    fn ensure_ready(&self, slot: &mut Slot) -> Result<()> {
        if matches!(slot.health, Health::Unverified) {
            let mut scratch = StartupReport {
                threads: 0,
                index: IndexOutcome::Loaded,
                logs_opened: 0,
                refolded: Vec::new(),
                settled: Vec::new(),
                repaired: Vec::new(),
                abandoned_creates: Vec::new(),
                removed_deleted: Vec::new(),
                corrupt: Vec::new(),
                unsupported: Vec::new(),
                unindexed: Vec::new(),
                timings: StartupTimings::default(),
            };
            let before = slot.card.applied_seq;
            match self.verify_and_refold(slot, &mut scratch) {
                Ok(()) => {
                    if slot.card.applied_seq != before {
                        self.persist(slot)?;
                    }
                }
                Err(StoreError::CorruptLog { detail, .. }) => slot.health = Health::Corrupt(detail),
                Err(e) => return Err(e),
            }
        }
        slot.check_health()
    }

    /// Write card.json and the index row for the slot's current state, after syncing the log.
    /// The row stays dirty while a run is active. card.json is replaced atomically but not synced:
    /// startup trusts the index row, and a card.json lost to power failure is refolded on rebuild.
    fn persist(&self, slot: &mut Slot) -> Result<()> {
        self.sync_log(slot)?;
        self.write_cache(slot)
    }

    /// Sync the log up to its current length. A failure poisons the thread: the outcome of the
    /// last write is uncertain until a reopen checks the actual tail.
    fn sync_log(&self, slot: &mut Slot) -> Result<()> {
        if !self.opts.fsync || slot.synced_len >= slot.len {
            slot.synced_len = slot.len;
            return Ok(());
        }
        let result = (|| -> std::io::Result<()> {
            let file = match slot.writer.as_ref() {
                Some(w) => w.try_clone()?,
                None => log::open_append(&slot.log_path())?,
            };
            self.sync_file(&file)
        })();
        match result {
            Ok(()) => {
                slot.synced_len = slot.len;
                Ok(())
            }
            Err(e) => {
                slot.health = Health::Poisoned(e.to_string());
                slot.writer = None;
                Err(e.into())
            }
        }
    }

    /// Write card.json and the index row (the log must already be synced through appliedSeq).
    fn write_cache(&self, slot: &mut Slot) -> Result<()> {
        if self.faults().fail_cache_writes {
            return Err(StoreError::Io(injected("card.json write")));
        }
        let doc = card_doc(&slot.card, &slot.fold)?;
        atomic_write(&slot.dir.join(CARD_FILE), doc.as_bytes(), false)?;
        let active = slot.fold.active_run_id.is_some();
        {
            let mut shared = lock(&self.shared);
            shared.index.upsert(&[(&slot.card, active, active, doc)])?;
            if let Some(card) = shared.cards.get_mut(&slot.id) {
                *card = slot.card.clone();
            }
        }
        slot.durable_dirty = active;
        slot.stale = false;
        slot.cache_error = None;
        Ok(())
    }

    /// Create a thread folder with its log, card.json and index row. Returns the card.
    pub fn create_thread(
        &self,
        id: Option<ThreadId>,
        created: ThreadCreated,
    ) -> Result<ThreadCard> {
        self.create_thread_inner(id, created, u8::MAX)
    }

    fn create_thread_inner(
        &self,
        id: Option<ThreadId>,
        created: ThreadCreated,
        stop_after: u8,
    ) -> Result<ThreadCard> {
        let id = id.unwrap_or_else(|| ThreadId::new(new_uuid()));
        validate_thread_id(id.as_str())?;
        if self.slot(&id).is_some() {
            return Err(StoreError::ThreadExists(id.to_string()));
        }
        let dir = self.thread_dir(&id);
        if dir.exists() {
            return Err(StoreError::ThreadExists(id.to_string()));
        }
        let mut created = created;
        created.title = clamp_chars(&created.title, CARD_TITLE_MAX_CHARS);
        let size = serde_json::to_vec(&created)?.len();
        if size > BLOB_THRESHOLD_BYTES {
            return Err(StoreError::PayloadTooLarge(format!(
                "thread.created event is {size} bytes"
            )));
        }
        // 1. creation intent
        lock(&self.shared).index.mark(id.as_str(), true, true)?;
        if stop_after == 1 {
            return Err(StoreError::InvalidEvent("test stop after step 1".into()));
        }
        // 2. folder
        fs::create_dir(&dir)?;
        if stop_after == 2 {
            return Err(StoreError::InvalidEvent("test stop after step 2".into()));
        }
        // 3. log with header + thread.created
        let epoch = Epoch::new(new_uuid());
        let at = now_rfc3339();
        let first = LogLine::new(1, at.clone(), LogEvent::ThreadCreated(created.clone()));
        let bytes = line::encode(&first)?;
        if stop_after == 3 {
            let mut header = serde_json::to_vec(&LogHeader::new(epoch.clone()))?;
            header.truncate(header.len() / 2);
            fs::write(dir.join(LOG_FILE), header)?;
            return Err(StoreError::InvalidEvent("test stop inside step 3".into()));
        }
        let (header_end, len) = log::create(&dir.join(LOG_FILE), &epoch, &bytes, self.opts.fsync)?;
        if self.opts.fsync {
            sync_dir(&dir)?;
            sync_dir(&self.threads_dir())?;
        }
        if stop_after == 4 {
            return Err(StoreError::InvalidEvent("test stop after step 4".into()));
        }
        // 4. card.json + row (clears the creation intent)
        let (card, fold) = fold::initial(&id, &created, &epoch, 1, &at);
        let mut slot = self.new_slot(id.clone(), card, fold, Health::Ready);
        slot.header_end = header_end;
        slot.len = len;
        slot.synced_len = len;
        // Nothing is visible until the cache is written; a failure here leaves the committed log for
        // the next start to finish (creating row). The thread is installed with its lock held, so an
        // append or delete on it waits until the card is announced, and the cardSeq is assigned in
        // the same step as the announcement, so no card cursor can pass over it.
        self.persist(&mut slot)?;
        let entry = Arc::new(Mutex::new(slot));
        let mut installed = lock(&entry);
        self.slots
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, entry.clone());
        let pause = lock(&self.create_pause).clone();
        if let Some((reached, release)) = pause {
            reached.wait();
            release.wait();
        }
        lock(&self.shared).publish(&mut installed.card);
        Ok(installed.card.clone())
    }

    /// Append events to a thread. Assigns seq and time, validates, moves large item fields to
    /// blobs, folds, writes all lines with one write, adds a checkpoint after `run.finished`, and
    /// syncs before returning when the batch contains a send boundary or mailbox event.
    pub fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> Result<Appended> {
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let mut slot = lock(&slot);
        self.ensure_ready(&mut slot)?;
        for event in &events {
            if matches!(event, LogEvent::ThreadCreated(_) | LogEvent::Checkpoint(_)) {
                return Err(StoreError::InvalidEvent(format!(
                    "{} lines are written by the store",
                    event.type_tag()
                )));
            }
        }
        self.append_locked(&mut slot, events)
    }

    fn validate(
        &self,
        slot: &Slot,
        card: &ThreadCard,
        fold: &Fold,
        event: &mut LogEvent,
    ) -> Result<Option<String>> {
        let invalid = |msg: String| Err(StoreError::InvalidEvent(msg));
        match event {
            LogEvent::ThreadChanged(e) => {
                if let Some(title) = &mut e.title {
                    *title = clamp_chars(title, CARD_TITLE_MAX_CHARS);
                }
            }
            LogEvent::InputAccepted(e) => {
                if e.text.len() > BLOB_THRESHOLD_BYTES {
                    return Err(StoreError::PayloadTooLarge(format!(
                        "input {} text is {} bytes; the host stores large input as an attachment",
                        e.input_id,
                        e.text.len()
                    )));
                }
                if fold.queued_inputs.iter().any(|q| q.input_id == e.input_id) {
                    return invalid(format!("input {} is already queued", e.input_id));
                }
            }
            LogEvent::InputChanged(e) => {
                let Some(pos) = fold
                    .queued_inputs
                    .iter()
                    .position(|q| q.input_id == e.input_id)
                else {
                    return invalid(format!("input {} is not queued", e.input_id));
                };
                let _ = pos;
                if let Some(p) = e.position
                    && p as usize >= fold.queued_inputs.len()
                {
                    return invalid(format!("position {p} is outside the queue"));
                }
                if let Some(text) = &e.text
                    && text.len() > BLOB_THRESHOLD_BYTES
                {
                    return Err(StoreError::PayloadTooLarge(format!(
                        "input {} text",
                        e.input_id
                    )));
                }
            }
            LogEvent::RunStarted(e) => {
                if let Some(active) = &fold.active_run_id {
                    return invalid(format!(
                        "run {active} is still active; cannot start {}",
                        e.run_id
                    ));
                }
            }
            LogEvent::RunFinished(e) if fold.active_run_id.as_ref() != Some(&e.run_id) => {
                return invalid(format!("run {} is not the active run", e.run_id));
            }
            LogEvent::RunAccepted(e) if fold.active_run_id.as_ref() != Some(&e.run_id) => {
                return invalid(format!("run {} is not the active run", e.run_id));
            }
            LogEvent::RequestOpened(e) => {
                e.summary = clamp_chars(&e.summary, NEEDS_YOU_SUMMARY_MAX_CHARS);
            }
            LogEvent::ChildStarted(e) => {
                if fold.running_child_ids.contains(&e.child_thread_id) {
                    return invalid(format!("child {} is already running", e.child_thread_id));
                }
                let shared = lock(&self.shared);
                let parent_ok = shared
                    .cards
                    .get(&e.child_thread_id)
                    .and_then(|c| c.parent.as_ref())
                    .is_some_and(|p| p.thread_id == card.id);
                if !parent_ok {
                    return invalid(format!(
                        "child {} does not exist or its parent is not {}",
                        e.child_thread_id, slot.id
                    ));
                }
            }
            LogEvent::ChildReported(e) => {
                e.summary = clamp_bytes(&e.summary, CHILD_SUMMARY_MAX_BYTES);
            }
            LogEvent::ItemCompleted(item) => return blob::prepare_item(item),
            _ => {}
        }
        Ok(None)
    }

    fn append_locked(&self, slot: &mut Slot, events: Vec<LogEvent>) -> Result<Appended> {
        let mut card = slot.card.clone();
        let mut fold_state = slot.fold.clone();
        let old_status = card.status;
        let mut lines: Vec<LogLine> = Vec::new();
        let mut pending_blobs: Vec<(usize, String, String)> = Vec::new();
        let mut needs_sync = false;
        let mut finished = false;
        let at = now_rfc3339();
        for mut event in events {
            let blob_text = self.validate(slot, &card, &fold_state, &mut event)?;
            needs_sync |= matches!(
                event,
                LogEvent::InputAccepted(_)
                    | LogEvent::InputChanged(_)
                    | LogEvent::InputDelivered(_)
                    | LogEvent::RunStarted(_)
                    | LogEvent::RunAccepted(_)
                    | LogEvent::RequestResolved(_)
                    | LogEvent::RunFinished(_)
            );
            if !matches!(event, LogEvent::ItemCompleted(_)) {
                let size = serde_json::to_vec(&event)?.len();
                if size > BLOB_THRESHOLD_BYTES {
                    return Err(StoreError::PayloadTooLarge(format!(
                        "{} event is {size} bytes",
                        event.type_tag()
                    )));
                }
            }
            let is_finish = matches!(event, LogEvent::RunFinished(_));
            if let (Some(text), LogEvent::ItemCompleted(item)) = (blob_text, &event) {
                pending_blobs.push((lines.len(), item.item.id.to_string(), text));
            }
            let line = LogLine::new(card.applied_seq + 1, at.clone(), event);
            fold::apply(&mut card, &mut fold_state, &line);
            lines.push(line);
            if is_finish && WRITE_CHECKPOINTS {
                let seq = card.applied_seq + 1;
                let mut snapshot = card.clone();
                snapshot.applied_seq = seq;
                snapshot.updated_at = at.clone();
                let line = LogLine::new(
                    seq,
                    at.clone(),
                    LogEvent::Checkpoint(Checkpoint {
                        card: snapshot,
                        fold: fold_state.clone(),
                    }),
                );
                fold::apply(&mut card, &mut fold_state, &line);
                lines.push(line);
                finished = true;
            }
        }
        if lines.is_empty() {
            return Ok(Appended {
                lines,
                card: slot.card.clone(),
                fold: slot.fold.clone(),
            });
        }
        // Dirty mark before the log changes.
        if !slot.durable_dirty {
            lock(&self.shared)
                .index
                .mark(slot.id.as_str(), true, false)?;
            slot.durable_dirty = true;
        }
        // Blobs before the lines that point at them.
        for (i, name, text) in pending_blobs {
            let blob_ref = blob::write_blob(&slot.dir, &name, text.as_bytes(), self.opts.fsync)?;
            if let LogEvent::ItemCompleted(item) = &mut lines[i].event {
                item.blob = Some(blob_ref);
            }
        }
        let mut bytes = Vec::new();
        for line in &lines {
            bytes.extend_from_slice(&line::encode(line)?);
        }
        if let Err(e) = self.write_log(slot, &bytes, needs_sync) {
            slot.health = Health::Poisoned(e.to_string());
            slot.writer = None;
            return Err(e);
        }
        // Written through (outside a run, status change, run end): the log must be durable before
        // anything is published. A failure poisons the thread and nothing is published.
        let write_through =
            fold_state.active_run_id.is_none() || old_status != card.status || finished;
        if write_through {
            self.sync_log(slot)?;
        }
        let card_changed = {
            let mut a = card.clone();
            a.card_seq = slot.card.card_seq;
            a.applied_seq = slot.card.applied_seq;
            a.updated_at = slot.card.updated_at.clone();
            a != slot.card
        };
        slot.card = card;
        slot.fold = fold_state;
        if card_changed {
            let mut shared = lock(&self.shared);
            shared.publish(&mut slot.card);
        } else {
            lock(&self.shared)
                .cards
                .insert(slot.id.clone(), slot.card.clone());
        }
        if write_through {
            // The log is the source; a failed cache write keeps the row dirty and is retried.
            if let Err(e) = self.write_cache(slot) {
                slot.stale = true;
                slot.cache_error = Some(e.to_string());
            }
        } else {
            slot.stale = true;
        }
        let update = ThreadUpdate {
            lines: lines.clone(),
        };
        slot.subs.retain(|tx| tx.try_send(update.clone()).is_ok());
        Ok(Appended {
            lines,
            card: slot.card.clone(),
            fold: slot.fold.clone(),
        })
    }

    fn write_log(&self, slot: &mut Slot, bytes: &[u8], sync: bool) -> Result<()> {
        if slot.writer.is_none() {
            slot.writer = Some(log::open_append(&slot.log_path())?);
        }
        let writer = slot.writer.as_mut().expect("writer opened above");
        writer.write_all(bytes)?;
        slot.len += bytes.len() as u64;
        if sync && self.opts.fsync {
            if self.faults().fail_log_syncs {
                return Err(StoreError::Io(injected("log sync")));
            }
            writer.sync_data()?;
            slot.synced_len = slot.len;
        } else if !self.opts.fsync {
            slot.synced_len = slot.len;
        }
        Ok(())
    }

    /// Write batched in-run card.json / index rows. The host calls this on a timer.
    pub fn flush(&self) -> Result<()> {
        let slots: Vec<_> = self
            .slots
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        let mut first_error = None;
        for slot in slots {
            let mut slot = lock(&slot);
            let result = match &slot.health {
                Health::Ready if slot.stale => self.persist(&mut slot),
                // A thread whose last write failed has an uncertain outcome: keep reporting it until
                // the store is reopened and the tail is checked.
                Health::Poisoned(detail) => Err(StoreError::Poisoned {
                    thread: slot.id.to_string(),
                    detail: detail.clone(),
                }),
                _ => Ok(()),
            };
            if let Err(e) = result
                && first_error.is_none()
            {
                first_error = Some(e);
            }
        }
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Flush and release the store.
    pub fn close(self) -> Result<()> {
        self.flush()
    }

    /// The card of one thread (catching up its log tail on first touch).
    pub fn card(&self, id: &ThreadId) -> Result<Option<ThreadCard>> {
        let Some(slot) = self.slot(id) else {
            return Ok(None);
        };
        let mut slot = lock(&slot);
        if slot.is_deleted() {
            return Ok(None);
        }
        self.ensure_ready(&mut slot)?;
        Ok(Some(slot.card.clone()))
    }

    /// The fold of one thread (queued / held inputs, active run, open requests), caught up like
    /// `card`.
    pub fn fold(&self, id: &ThreadId) -> Result<Option<Fold>> {
        let Some(slot) = self.slot(id) else {
            return Ok(None);
        };
        let mut slot = lock(&slot);
        if slot.is_deleted() {
            return Ok(None);
        }
        self.ensure_ready(&mut slot)?;
        Ok(Some(slot.fold.clone()))
    }

    /// Cards matching the filter, from memory (the card index), newest update first.
    pub fn find(&self, filter: &CardFilter) -> Vec<ThreadCard> {
        let shared = lock(&self.shared);
        let mut cards: Vec<ThreadCard> = shared
            .cards
            .values()
            .filter(|c| filter.matches(c))
            .cloned()
            .collect();
        cards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        cards
    }

    fn cards_after_locked(shared: &Shared, after: Option<&CardCursor>) -> CardsRead {
        let cursor = CardCursor {
            epoch: shared.epoch.clone(),
            card_seq: shared.max_card_seq(),
        };
        let reset = match after {
            None => None,
            Some(c) if c.epoch != shared.epoch => Some(ResetReason::EpochChanged),
            Some(c) if c.card_seq > shared.max_card_seq() => Some(ResetReason::InvalidCursor),
            // structure/30_wire.md: no tombstones in Part 1; a cursor from before a deletion resets.
            Some(c) if c.card_seq < shared.last_deletion_seq => Some(ResetReason::ThreadMissing),
            Some(c) => {
                let mut cards: Vec<ThreadCard> = shared
                    .cards
                    .values()
                    .filter(|card| card.card_seq > c.card_seq)
                    .cloned()
                    .collect();
                cards.sort_by_key(|card| card.card_seq);
                return CardsRead {
                    reset: None,
                    cards,
                    cursor,
                };
            }
        };
        let mut cards: Vec<ThreadCard> = shared.cards.values().cloned().collect();
        cards.sort_by_key(|c| c.card_seq);
        CardsRead {
            reset,
            cards,
            cursor,
        }
    }

    /// Changed cards after the cursor, or every card with a reset reason.
    pub fn cards_after(&self, after: Option<&CardCursor>) -> CardsRead {
        Self::cards_after_locked(&lock(&self.shared), after)
    }

    /// `cards_after` plus a live channel registered under the same lock.
    pub fn subscribe_cards(&self, after: Option<&CardCursor>) -> (CardsRead, Receiver<CardUpdate>) {
        let mut shared = lock(&self.shared);
        let read = Self::cards_after_locked(&shared, after);
        let (tx, rx) = sync_channel(SUB_CAPACITY);
        shared.subs.push(tx);
        (read, rx)
    }

    /// Read a thread from a cursor. See the cursor contract in DESIGN.md.
    pub fn read(&self, id: &ThreadId, after: Option<&ThreadCursor>) -> Result<ThreadRead> {
        let Some(slot) = self.slot(id) else {
            return Ok(ThreadRead {
                reset: Some(ResetReason::ThreadMissing),
                snapshot: None,
                lines: Vec::new(),
                cursor: None,
            });
        };
        let mut slot = lock(&slot);
        if slot.is_deleted() {
            return Ok(ThreadRead {
                reset: Some(ResetReason::ThreadMissing),
                snapshot: None,
                lines: Vec::new(),
                cursor: None,
            });
        }
        self.ensure_ready(&mut slot)?;
        self.read_locked(&mut slot, after)
    }

    /// `read` plus a live channel registered under the thread lock, so no line falls between the
    /// replay and the live updates. A full channel drops the subscriber; resubscribe with the last
    /// cursor.
    pub fn subscribe_thread(
        &self,
        id: &ThreadId,
        after: Option<&ThreadCursor>,
    ) -> Result<(ThreadRead, Receiver<ThreadUpdate>)> {
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let mut slot = lock(&slot);
        self.ensure_ready(&mut slot)?;
        let read = self.read_locked(&mut slot, after)?;
        let (tx, rx) = sync_channel(SUB_CAPACITY);
        slot.subs.push(tx);
        Ok((read, rx))
    }

    fn current_snapshot(slot: &Slot) -> Snapshot {
        Snapshot {
            seq: slot.card.applied_seq,
            card: slot.card.clone(),
            fold: slot.fold.clone(),
            from_checkpoint: false,
        }
    }

    /// Lines with seq > `after` while within the replay limits. `None` when over the limits.
    fn lines_after(&self, slot: &mut Slot, after: u64) -> Result<Option<Vec<LogLine>>> {
        let file = self.open_log_read(&slot.log_path())?;
        let mut out: Vec<LogLine> = Vec::new();
        let mut count = 0usize;
        let mut bytes = 0usize;
        let mut over = false;
        let id = slot.id.to_string();
        let mut hints = Vec::new();
        log::scan_back(
            &file,
            slot.header_end,
            slot.len,
            |start, raw| -> Result<bool> {
                let parsed = line::decode(raw).map_err(|detail| StoreError::CorruptLog {
                    thread: id.clone(),
                    detail,
                })?;
                let seq = parsed.seq();
                if seq.is_multiple_of(HINT_EVERY) {
                    hints.push((seq, start));
                }
                if seq <= after {
                    return Ok(false);
                }
                count += 1;
                bytes += raw.len() + 1;
                if count > REPLAY_MAX_EVENTS || bytes > REPLAY_MAX_BYTES {
                    over = true;
                    return Ok(false);
                }
                if let Parsed::Event(line) = parsed {
                    out.push(*line);
                }
                Ok(true)
            },
        )?;
        slot.hints.extend(hints);
        if over {
            return Ok(None);
        }
        out.reverse();
        Ok(Some(out))
    }

    /// The view for a reader with no usable cursor.
    fn initial_view(&self, slot: &mut Slot) -> Result<(Option<Snapshot>, Vec<LogLine>)> {
        let file = self.open_log_read(&slot.log_path())?;
        let mut collected: Vec<LogLine> = Vec::new();
        let mut count = 0usize;
        let mut bytes = 0usize;
        let mut checkpoint: Option<(u64, Checkpoint)> = None;
        let mut over = false;
        let id = slot.id.to_string();
        log::scan_back(&file, slot.header_end, slot.len, |_, raw| -> Result<bool> {
            let parsed = line::decode(raw).map_err(|detail| StoreError::CorruptLog {
                thread: id.clone(),
                detail,
            })?;
            if let Parsed::Event(line) = &parsed
                && let LogEvent::Checkpoint(cp) = &line.event
                && WRITE_CHECKPOINTS
                && line::checkpoint_is_complete(raw)
            {
                checkpoint = Some((line.seq, cp.clone()));
                return Ok(false);
            }
            count += 1;
            bytes += raw.len() + 1;
            if count > REPLAY_MAX_EVENTS || bytes > REPLAY_MAX_BYTES {
                over = true;
                return Ok(false);
            }
            if let Parsed::Event(line) = parsed {
                collected.push(*line);
            }
            Ok(true)
        })?;
        if over {
            return Ok((Some(Self::current_snapshot(slot)), Vec::new()));
        }
        collected.reverse();
        let snapshot = checkpoint.map(|(seq, cp)| Snapshot {
            seq,
            card: cp.card,
            fold: cp.fold,
            from_checkpoint: true,
        });
        Ok((snapshot, collected))
    }

    fn read_locked(&self, slot: &mut Slot, after: Option<&ThreadCursor>) -> Result<ThreadRead> {
        let head = slot.card.applied_seq;
        let cursor = Some(ThreadCursor {
            epoch: slot.card.epoch.clone(),
            seq: head,
        });
        let reset = match after {
            None => None,
            Some(c) if c.epoch != slot.card.epoch => Some(ResetReason::EpochChanged),
            Some(c) if c.seq > head => Some(ResetReason::InvalidCursor),
            Some(c) if c.seq == head => {
                return Ok(ThreadRead {
                    reset: None,
                    snapshot: None,
                    lines: Vec::new(),
                    cursor,
                });
            }
            Some(c) => match self.lines_after(slot, c.seq)? {
                Some(lines) => {
                    return Ok(ThreadRead {
                        reset: None,
                        snapshot: None,
                        lines,
                        cursor,
                    });
                }
                None => Some(ResetReason::TooFarBehind),
            },
        };
        let (snapshot, lines) = self.initial_view(slot)?;
        Ok(ThreadRead {
            reset,
            snapshot,
            lines,
            cursor,
        })
    }

    /// Up to `limit` lines with seq < `before`, oldest first.
    pub fn read_page(&self, id: &ThreadId, before: u64, limit: u32) -> Result<Page> {
        if limit == 0 || limit > PAGE_MAX {
            return Err(StoreError::InvalidLimit(limit));
        }
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let mut slot = lock(&slot);
        self.ensure_ready(&mut slot)?;
        let head = slot.card.applied_seq;
        if before > head + 1 {
            return Err(StoreError::InvalidCursor(format!(
                "before {before} is past the head {head}"
            )));
        }
        // Start from the nearest known line start at or after `before`.
        let end = slot
            .hints
            .range(before..)
            .next()
            .map(|(_, offset)| *offset)
            .unwrap_or(slot.len);
        let file = self.open_log_read(&slot.log_path())?;
        let mut out: Vec<LogLine> = Vec::new();
        let mut first_seq = None;
        let mut page_bytes = 0usize;
        let id_text = slot.id.to_string();
        let mut hints = Vec::new();
        log::scan_back(&file, slot.header_end, end, |start, raw| -> Result<bool> {
            let parsed = line::decode(raw).map_err(|detail| StoreError::CorruptLog {
                thread: id_text.clone(),
                detail,
            })?;
            let seq = parsed.seq();
            if seq.is_multiple_of(HINT_EVERY) {
                hints.push((seq, start));
            }
            if seq >= before {
                return Ok(true);
            }
            // v1 threadHistoryPaging.ts:16-21: every page also stops at 1 MiB of encoded lines.
            if !out.is_empty() && page_bytes + raw.len() + 1 > REPLAY_MAX_BYTES {
                return Ok(false);
            }
            page_bytes += raw.len() + 1;
            first_seq = Some(seq);
            if let Parsed::Event(line) = parsed {
                out.push(*line);
            }
            Ok(out.len() < limit as usize)
        })?;
        slot.hints.extend(hints);
        out.reverse();
        Ok(Page {
            has_more: first_seq.is_some_and(|s| s > 1),
            lines: out,
        })
    }

    /// Raw JSON lines with seq > `after`, up to `limit`, oldest first. Works for threads this build
    /// cannot fold.
    pub fn read_raw(&self, id: &ThreadId, after: u64, limit: u32) -> Result<Vec<String>> {
        if limit == 0 || limit > PAGE_MAX {
            return Err(StoreError::InvalidLimit(limit));
        }
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let slot = lock(&slot);
        if slot.is_deleted() {
            return Err(StoreError::ThreadMissing(id.to_string()));
        }
        let file = self.open_log_read(&slot.log_path())?;
        let len = file.metadata()?.len();
        let (_, header_end) = log::read_header(&file, len).map_err(|e| StoreError::CorruptLog {
            thread: slot.id.to_string(),
            detail: tail_problem(e).unwrap_or_else(|e| e.to_string()),
        })?;
        let mut out = Vec::new();
        let mut index = 0u64;
        log::scan_forward(&file, header_end, len, |_, raw| -> Result<bool> {
            index += 1;
            if index > after {
                out.push(String::from_utf8_lossy(raw).into_owned());
            }
            Ok(out.len() < limit as usize)
        })?;
        Ok(out)
    }

    /// Store bytes as a blob of this thread (for attachments) and return its ref.
    pub fn put_blob(&self, id: &ThreadId, name_hint: &str, bytes: &[u8]) -> Result<BlobRef> {
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let slot = lock(&slot);
        if slot.is_deleted() {
            return Err(StoreError::ThreadMissing(id.to_string()));
        }
        blob::write_blob(&slot.dir, name_hint, bytes, self.opts.fsync)
    }

    /// Read a blob by its `BlobRef.path`.
    pub fn read_blob(&self, id: &ThreadId, blob: &BlobRef) -> Result<Vec<u8>> {
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let slot = lock(&slot);
        if slot.is_deleted() {
            return Err(StoreError::ThreadMissing(id.to_string()));
        }
        blob::read_blob(&slot.dir, &blob.path)
    }

    /// Delete a thread: its folder goes to trash, then its row is removed.
    pub fn delete_thread(&self, id: &ThreadId) -> Result<()> {
        self.delete_thread_inner(id, false)
    }

    fn delete_thread_inner(&self, id: &ThreadId, stop_after_rename: bool) -> Result<()> {
        let slot = self
            .slot(id)
            .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
        let mut slot = lock(&slot);
        if slot.is_deleted() {
            return Err(StoreError::ThreadMissing(id.to_string()));
        }
        let pause = lock(&self.delete_pause).clone();
        if let Some(b) = &pause {
            b[0].wait();
            b[1].wait();
        }
        lock(&self.shared).index.mark(id.as_str(), true, false)?;
        slot.durable_dirty = true;
        slot.writer = None;
        let trash = self
            .threads_dir()
            .join(format!(".trash-{}-{}", id.as_str(), random_hex(8)));
        fs::rename(&slot.dir, &trash)?;
        // From here on, anyone who was waiting for this lock must not touch the path again.
        slot.health = Health::Deleted;
        if self.opts.fsync {
            sync_dir(&self.threads_dir())?;
        }
        if stop_after_rename {
            return Ok(());
        }
        {
            let mut shared = lock(&self.shared);
            shared.index.delete(id.as_str())?;
            shared.cards.remove(id);
            let seq = shared.next_card_seq;
            shared.next_card_seq += 1;
            shared.last_deletion_seq = seq;
            let update = CardUpdate::Removed {
                thread_id: id.clone(),
                card_seq: seq,
            };
            shared.subs.retain(|tx| tx.try_send(update.clone()).is_ok());
        }
        self.slots
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        if let Some(b) = &pause {
            b[2].wait();
            b[3].wait();
        }
        drop(slot);
        let _ = fs::remove_dir_all(&trash);
        Ok(())
    }

    /// The card index epoch (new for every `open`).
    pub fn index_epoch(&self) -> Epoch {
        lock(&self.shared).epoch.clone()
    }

    /// Data directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The last failed card.json / index write of a thread, while its cache is behind.
    pub fn cache_error(&self, id: &ThreadId) -> Option<String> {
        self.slot(id).and_then(|s| lock(&s).cache_error.clone())
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        if !self.crashed.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = self.flush();
        }
    }
}

/// Fault hooks for crash tests and benchmarks. Not part of the API.
pub mod testing {
    use super::*;

    /// Make every `create_thread` wait on `reached` and then `release` right before it announces
    /// the new card (`None` turns the pause off).
    pub fn pause_creates_before_announce(
        store: &Store,
        barriers: Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>,
    ) {
        *lock(&store.create_pause) = barriers;
    }

    /// Make `delete_thread` wait on the four barriers (see `Store::delete_pause`); `None` turns
    /// the pause off.
    pub fn pause_deletes(store: &Store, barriers: Option<[Arc<std::sync::Barrier>; 4]>) {
        *lock(&store.delete_pause) = barriers;
    }

    /// Change the injected faults of a running store.
    pub fn set_faults(store: &Store, faults: Faults) {
        *lock(&store.faults) = faults;
    }

    /// Drop the store without flushing batched card writes, as a crash would.
    pub fn crash(store: Store) {
        store
            .crashed
            .store(true, std::sync::atomic::Ordering::Relaxed);
        drop(store);
    }

    /// Run `create_thread` and stop after step 1 (intent), 2 (folder), 3 (inside the log write:
    /// half a header) or 4 (log written, card.json and row not yet).
    pub fn create_thread_stopping_after(
        store: &Store,
        id: ThreadId,
        created: ThreadCreated,
        step: u8,
    ) -> Result<ThreadCard> {
        store.create_thread_inner(Some(id), created, step)
    }

    /// Run `delete_thread` and stop right after the folder moved to trash.
    pub fn delete_thread_stopping_after_rename(store: &Store, id: &ThreadId) -> Result<()> {
        store.delete_thread_inner(id, true)
    }
}

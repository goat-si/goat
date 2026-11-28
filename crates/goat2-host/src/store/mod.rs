//! Thread store seam over `goat2-thread-store` (lane A).
//!
//! The host uses [ThreadStore]; [LaneAStore] implements it with lane A's `Store` (per-thread
//! folders, `cards.sqlite`, batched card writes, startup settlement, blobs). Lane A's API is
//! synchronous: body reads (`read_after`, `read_page`, `latest_checkpoint_seq`) may block and
//! are called from `spawn_blocking`; appends are short and called inline.
//!
//! The store writes `checkpoint` itself after every `run.finished` and settles runs left active
//! when it opens (`StartupReport.settled`); the host never writes either.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use goat2_contracts::{
    CardCursor, Epoch, Fold, LogEvent, LogLine, ResetReason, ThreadCard, ThreadCreated,
    ThreadCursor, ThreadId,
};
use goat2_thread_store::{CardFilter, Store, StoreOptions};
pub use goat2_thread_store::{Result as StoreResult, StartupReport, StoreError};

/// Request id of the resend request for an unknown run (`resend:<runId>`).
pub use goat2_thread_store::fold::resend_request_id;

/// What an append produced.
#[derive(Debug, Clone)]
pub struct Appended {
    pub lines: Vec<LogLine>,
    pub card: ThreadCard,
    pub fold: Fold,
}

/// Cards changed after a cursor, or every card with a reset.
#[derive(Debug, Clone)]
pub struct CardsAfter {
    pub reset: Option<ResetReason>,
    pub cards: Vec<ThreadCard>,
    pub cursor: CardCursor,
}

/// The store operations the host uses.
pub trait ThreadStore: Send + Sync + 'static {
    /// Card index generation, new on every start.
    fn index_epoch(&self) -> Epoch;
    /// Create the folder and write the header plus `thread.created` (seq 1).
    fn create(&self, id: &ThreadId, created: ThreadCreated) -> StoreResult<Appended>;
    /// Append events in order; the store assigns seq and `at`, validates and folds. Batches with
    /// `run.started` (the send boundary) are on disk when this returns.
    fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended>;
    fn card(&self, id: &ThreadId) -> Option<ThreadCard>;
    fn fold(&self, id: &ThreadId) -> Option<Fold>;
    /// Every card, ordered by `cardSeq`.
    fn cards(&self) -> Vec<ThreadCard>;
    /// Cards with `cardSeq` after the cursor; every card + a reset when the cursor is from
    /// another epoch, past the end or before a deletion.
    fn cards_after(&self, after: Option<&CardCursor>) -> CardsAfter;
    fn delete(&self, id: &ThreadId) -> StoreResult<()>;
    fn thread_epoch(&self, id: &ThreadId) -> Option<Epoch>;
    /// Last written seq.
    fn last_seq(&self, id: &ThreadId) -> Option<u64>;
    /// Lines with `seq > after`, oldest first.
    fn read_after(&self, id: &ThreadId, after: u64) -> StoreResult<Vec<LogLine>>;
    /// Up to `limit` lines with `seq < before`, oldest first, and whether older lines exist.
    fn read_page(
        &self,
        id: &ThreadId,
        before: u64,
        limit: usize,
    ) -> StoreResult<(Vec<LogLine>, bool)>;
    /// Seq of the latest `checkpoint` line.
    fn latest_checkpoint_seq(&self, id: &ThreadId) -> StoreResult<Option<u64>>;
    /// Write batched in-run card updates (called on a timer).
    fn flush(&self) -> StoreResult<()>;
}

/// [ThreadStore] over lane A's `goat2_thread_store::Store`.
pub struct LaneAStore {
    store: Store,
    /// Current fold per thread. Each entry's lock is held across `Store::append` and the fold
    /// update, so concurrent appends to one thread advance the cache in seq order. Lane A's
    /// `Store::fold` (branch goat2_thread_store 9c8fcfe) replaces this cache once on goat2.
    folds: Mutex<HashMap<ThreadId, Arc<Mutex<Option<Fold>>>>>,
}

const PAGE: u32 = 512;

impl LaneAStore {
    /// Open `<data_dir>`: lane A settles runs left active and reports them.
    pub fn open(data_dir: &Path) -> StoreResult<(Self, StartupReport)> {
        let (store, report) = Store::open(data_dir, StoreOptions::default())?;
        Ok((
            Self {
                store,
                folds: Mutex::new(HashMap::new()),
            },
            report,
        ))
    }

    fn load_fold(&self, id: &ThreadId) -> StoreResult<Option<Fold>> {
        let read = self.store.read(id, None)?;
        if read.cursor.is_none() {
            return Ok(None);
        }
        let (mut card, mut fold, lines) = match read.snapshot {
            Some(snapshot) => (snapshot.card, snapshot.fold, read.lines),
            None => {
                let mut lines = read.lines.into_iter();
                let Some(first) = lines.next() else {
                    return Ok(None);
                };
                let LogEvent::ThreadCreated(created) = &first.event else {
                    return Err(StoreError::CorruptLog {
                        thread: id.to_string(),
                        detail: "first line is not thread.created".to_owned(),
                    });
                };
                let epoch = self
                    .store
                    .card(id)?
                    .map(|c| c.epoch)
                    .unwrap_or_else(|| Epoch::new(""));
                let (card, fold) =
                    goat2_thread_store::fold::initial(id, created, &epoch, first.seq, &first.at);
                (card, fold, lines.collect())
            }
        };
        for line in &lines {
            goat2_thread_store::fold::apply(&mut card, &mut fold, line);
        }
        Ok(Some(fold))
    }

    fn entry(&self, id: &ThreadId) -> Arc<Mutex<Option<Fold>>> {
        self.folds
            .lock()
            .expect("folds")
            .entry(id.clone())
            .or_default()
            .clone()
    }
}

impl ThreadStore for LaneAStore {
    fn index_epoch(&self) -> Epoch {
        self.store.index_epoch()
    }

    fn create(&self, id: &ThreadId, created: ThreadCreated) -> StoreResult<Appended> {
        let entry = self.entry(id);
        let mut cached = entry.lock().expect("fold");
        let card = self.store.create_thread(Some(id.clone()), created)?;
        let lines = self.store.read(id, None)?.lines;
        let fold = self.load_fold(id)?.unwrap_or_default();
        *cached = Some(fold.clone());
        Ok(Appended { lines, card, fold })
    }

    fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended> {
        let entry = self.entry(id);
        let mut cached = entry.lock().expect("fold");
        if cached.is_none() {
            *cached = self.load_fold(id)?;
        }
        let appended = self.store.append(id, events)?;
        let fold = match cached.as_mut() {
            Some(fold) => {
                let mut scratch = appended.card.clone();
                for line in &appended.lines {
                    goat2_thread_store::fold::apply(&mut scratch, fold, line);
                }
                fold.clone()
            }
            None => {
                let fold = self.load_fold(id)?.unwrap_or_default();
                *cached = Some(fold.clone());
                fold
            }
        };
        Ok(Appended {
            lines: appended.lines,
            card: appended.card,
            fold,
        })
    }

    fn card(&self, id: &ThreadId) -> Option<ThreadCard> {
        self.store.card(id).ok().flatten()
    }

    fn fold(&self, id: &ThreadId) -> Option<Fold> {
        self.card(id)?;
        let entry = self.entry(id);
        let mut cached = entry.lock().expect("fold");
        if cached.is_none() {
            *cached = self.load_fold(id).ok().flatten();
        }
        cached.clone()
    }

    fn cards(&self) -> Vec<ThreadCard> {
        let mut cards = self.store.find(&CardFilter::default());
        cards.sort_by_key(|c| c.card_seq);
        cards
    }

    fn cards_after(&self, after: Option<&CardCursor>) -> CardsAfter {
        let read = self.store.cards_after(after);
        CardsAfter {
            reset: read.reset,
            cards: read.cards,
            cursor: read.cursor,
        }
    }

    fn delete(&self, id: &ThreadId) -> StoreResult<()> {
        self.folds.lock().expect("folds").remove(id);
        self.store.delete_thread(id)
    }

    fn thread_epoch(&self, id: &ThreadId) -> Option<Epoch> {
        self.card(id).map(|c| c.epoch)
    }

    fn last_seq(&self, id: &ThreadId) -> Option<u64> {
        self.card(id).map(|c| c.applied_seq)
    }

    fn read_after(&self, id: &ThreadId, after: u64) -> StoreResult<Vec<LogLine>> {
        let Some(head) = self.last_seq(id) else {
            return Err(StoreError::ThreadMissing(id.to_string()));
        };
        let mut out: Vec<LogLine> = Vec::new();
        let mut before = head + 1;
        while before > after + 1 {
            let page = self.store.read_page(id, before, PAGE)?;
            let Some(first) = page.lines.first().map(|l| l.seq) else {
                break;
            };
            let mut lines: Vec<LogLine> =
                page.lines.into_iter().filter(|l| l.seq > after).collect();
            lines.append(&mut out);
            out = lines;
            if !page.has_more || first <= after + 1 {
                break;
            }
            before = first;
        }
        Ok(out)
    }

    fn read_page(
        &self,
        id: &ThreadId,
        before: u64,
        limit: usize,
    ) -> StoreResult<(Vec<LogLine>, bool)> {
        let head = self.last_seq(id).unwrap_or(0);
        let before = before.min(head + 1);
        let page = self
            .store
            .read_page(id, before, limit.clamp(1, PAGE as usize) as u32)?;
        Ok((page.lines, page.has_more))
    }

    fn latest_checkpoint_seq(&self, id: &ThreadId) -> StoreResult<Option<u64>> {
        let Some(head) = self.last_seq(id) else {
            return Ok(None);
        };
        let mut before = head + 1;
        loop {
            let page = self.store.read_page(id, before, PAGE)?;
            if let Some(line) = page
                .lines
                .iter()
                .rev()
                .find(|l| matches!(l.event, LogEvent::Checkpoint(_)))
            {
                return Ok(Some(line.seq));
            }
            match page.lines.first() {
                Some(first) if page.has_more => before = first.seq,
                _ => return Ok(None),
            }
        }
    }

    fn flush(&self) -> StoreResult<()> {
        self.store.flush()
    }
}

/// Current cursor of a thread.
pub fn thread_cursor(store: &dyn ThreadStore, id: &ThreadId) -> Option<ThreadCursor> {
    Some(ThreadCursor {
        epoch: store.thread_epoch(id)?,
        seq: store.last_seq(id)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::{
        EngineConfig, FollowUpMode, InputAccepted, InputMode, InputSource, ModelSelection,
        RuntimeMode, ThreadKind,
    };

    #[test]
    fn concurrent_appends_keep_the_cached_fold_in_seq_order() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = LaneAStore::open(dir.path()).unwrap();
        let store = Arc::new(store);
        let id = ThreadId::new("t");
        store
            .create(
                &id,
                ThreadCreated {
                    kind: ThreadKind::User,
                    title: "t".into(),
                    project_id: None,
                    bot_id: None,
                    parent: None,
                    engine: EngineConfig {
                        provider_instance_id: "codex".into(),
                        model_selection: ModelSelection {
                            instance_id: "codex".into(),
                            model: "m".into(),
                            options: None,
                        },
                        runtime_mode: RuntimeMode::FullAccess,
                        cwd: "/tmp".into(),
                    },
                    follow_up_mode: FollowUpMode::Steer,
                },
            )
            .unwrap();
        let workers: Vec<_> = (0..8)
            .map(|w| {
                let (store, id) = (store.clone(), id.clone());
                std::thread::spawn(move || {
                    for i in 0..25 {
                        store
                            .append(
                                &id,
                                vec![LogEvent::InputAccepted(InputAccepted {
                                    input_id: format!("in_{w}_{i}").into(),
                                    from: InputSource::User,
                                    mode: InputMode::Followup,
                                    text: "x".into(),
                                    attachments: vec![],
                                    client_request_id: format!("k_{w}_{i}"),
                                })],
                            )
                            .unwrap();
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        let in_log: Vec<String> = store
            .read_after(&id, 0)
            .unwrap()
            .into_iter()
            .filter_map(|l| match l.event {
                LogEvent::InputAccepted(i) => Some(i.input_id.to_string()),
                _ => None,
            })
            .collect();
        let cached: Vec<String> = store
            .fold(&id)
            .unwrap()
            .queued_inputs
            .into_iter()
            .map(|q| q.input_id.to_string())
            .collect();
        assert_eq!(in_log.len(), 200);
        assert_eq!(cached, in_log, "the cache follows the log order");
    }
}

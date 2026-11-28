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
use std::sync::Mutex;

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
    /// Current fold per thread, advanced with every append. Lane A's Store has no fold accessor
    /// yet (requested); remove this cache when it lands.
    folds: Mutex<HashMap<ThreadId, Fold>>,
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

    fn advance(&self, id: &ThreadId, lines: &[LogLine], card: &ThreadCard) -> Fold {
        let mut folds = self.folds.lock().expect("folds");
        let cached = folds.remove(id);
        let fold = match cached {
            Some(mut fold) => {
                let mut scratch = card.clone();
                for line in lines {
                    goat2_thread_store::fold::apply(&mut scratch, &mut fold, line);
                }
                fold
            }
            None => {
                drop(folds);
                let fold = self.load_fold(id).ok().flatten().unwrap_or_default();
                folds = self.folds.lock().expect("folds");
                fold
            }
        };
        folds.insert(id.clone(), fold.clone());
        fold
    }
}

impl ThreadStore for LaneAStore {
    fn index_epoch(&self) -> Epoch {
        self.store.index_epoch()
    }

    fn create(&self, id: &ThreadId, created: ThreadCreated) -> StoreResult<Appended> {
        let card = self.store.create_thread(Some(id.clone()), created)?;
        let lines = self.store.read(id, None)?.lines;
        let fold = self.load_fold(id)?.unwrap_or_default();
        self.folds
            .lock()
            .expect("folds")
            .insert(id.clone(), fold.clone());
        Ok(Appended { lines, card, fold })
    }

    fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended> {
        let appended = self.store.append(id, events)?;
        let fold = self.advance(id, &appended.lines, &appended.card);
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
        if let Some(fold) = self.folds.lock().expect("folds").get(id) {
            return Some(fold.clone());
        }
        let fold = self.load_fold(id).ok().flatten()?;
        self.folds
            .lock()
            .expect("folds")
            .insert(id.clone(), fold.clone());
        Some(fold)
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

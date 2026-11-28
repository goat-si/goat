//! Thread store seam and the interim file-backed store.
//!
//! `goat2-thread-store` (lane A) owns the real store: batched card index writes with the dirty
//! mark, `cards.sqlite`, blobs above 64 KB, and the 1,000-thread startup measurement. Until it
//! lands on `goat2`, [FsStore] keeps the same on-disk layout (`threads/<id>/goat.jsonl`,
//! `card.json` = `{"v":1,"card":ThreadCard,"fold":Fold}`) with a simpler policy: every append
//! rewrites `card.json` atomically and the card index lives in memory under a fresh epoch per
//! start. Replace the [ThreadStore] implementation; the host only uses the trait.

mod fold;
mod fs;

pub use fold::{CardFold, fold_line, resend_request_id};
pub use fs::FsStore;

use goat2_contracts::{
    Epoch, Fold, InputAccepted, InputId, LogEvent, LogLine, ThreadCard, ThreadId,
};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("thread {0} not found")]
    NotFound(ThreadId),
    #[error("thread {0} already exists")]
    Exists(ThreadId),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("corrupt log line in {thread}: {message}")]
    Corrupt { thread: ThreadId, message: String },
}

pub type StoreResult<T> = Result<T, StoreError>;

/// What an append produced.
#[derive(Debug, Clone)]
pub struct Appended {
    pub lines: Vec<LogLine>,
    /// The card after the append, with its new `cardSeq`.
    pub card: ThreadCard,
    pub fold: Fold,
}

/// The store operations the host uses. Implementations must be cheap to call from async code
/// for appends and card reads; body reads (`read_after`, `read_page`, `find_inputs`) may block
/// and are called from `spawn_blocking`.
pub trait ThreadStore: Send + Sync + 'static {
    /// Card index generation, new on every start.
    fn index_epoch(&self) -> Epoch;
    /// Create the folder and write the header plus `thread.created` as seq 1.
    fn create(
        &self,
        id: &ThreadId,
        created: goat2_contracts::ThreadCreated,
    ) -> StoreResult<Appended>;
    /// Append events in order; assigns seq and `at`, folds the card.
    fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended>;
    /// Like [ThreadStore::append] but flushes to disk before returning (send boundary).
    fn append_durable(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended>;
    fn card(&self, id: &ThreadId) -> Option<ThreadCard>;
    fn fold(&self, id: &ThreadId) -> Option<Fold>;
    /// Every card, ordered by `cardSeq`.
    fn cards(&self) -> Vec<ThreadCard>;
    /// Remove a thread folder.
    fn delete(&self, id: &ThreadId) -> StoreResult<u64>;
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
    /// The `input.accepted` lines for these inputs (first acceptance of each), in log order.
    fn find_inputs(&self, id: &ThreadId, inputs: &[InputId]) -> StoreResult<Vec<InputAccepted>>;
}

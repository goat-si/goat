use std::io;

/// Errors returned by the store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("card index: {0}")]
    Index(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("the data directory is locked by another store")]
    Locked,
    #[error("thread {0} does not exist")]
    ThreadMissing(String),
    #[error("thread {0} already exists")]
    ThreadExists(String),
    #[error("invalid thread id {0:?}: use 1-128 of A-Z a-z 0-9 . _ - and do not start with a dot")]
    InvalidThreadId(String),
    #[error("thread {thread}: corrupt log: {detail}")]
    CorruptLog { thread: String, detail: String },
    #[error(
        "thread {thread}: line {seq} has type {kind:?} and v {v}, which this build cannot fold"
    )]
    UnsupportedEvent {
        thread: String,
        seq: u64,
        kind: String,
        v: u64,
    },
    #[error("payload too large: {0}")]
    PayloadTooLarge(String),
    #[error("invalid event: {0}")]
    InvalidEvent(String),
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
    #[error("invalid page limit {0} (1..=512)")]
    InvalidLimit(u32),
    #[error("invalid blob path {0:?}")]
    InvalidBlobPath(String),
    #[error(
        "thread {thread}: a write failed ({detail}); the thread accepts no writes until the store is reopened"
    )]
    Poisoned { thread: String, detail: String },
}

pub type Result<T> = std::result::Result<T, StoreError>;

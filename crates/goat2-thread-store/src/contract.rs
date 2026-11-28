//! Contract types used by the store. Everything comes from `goat2-contracts` (lane C); this module
//! only adds the store-side constants derived from it.

pub use goat2_contracts::limits::{
    BLOB_THRESHOLD_BYTES, CARD_EXCERPT_MAX_CHARS, CARD_FILE_FORMAT_VERSION, CARD_TITLE_MAX_CHARS,
    CHILD_SUMMARY_MAX_BYTES, LOG_FORMAT_VERSION, NEEDS_YOU_SUMMARY_MAX_CHARS, REPLAY_MAX_BYTES,
    REPLAY_MAX_EVENTS,
};
pub use goat2_contracts::text::{clamp_bytes, clamp_chars};
pub use goat2_contracts::*;

/// Keys a checkpoint's `fold` object must carry to be used as a snapshot. A checkpoint missing any
/// of them (for example one written before these fields existed) is plain history.
pub const FOLD_KEYS: [&str; 9] = [
    "activeRunId",
    "activeRunInputIds",
    "activeRunReachedEngine",
    "queuedInputs",
    "heldInputs",
    "openRequests",
    "runningChildIds",
    "lastRunOutcome",
    "counters",
];

/// The store appends a `checkpoint {card, fold}` line after every `run.finished`.
pub const WRITE_CHECKPOINTS: bool = true;

//! Fixed bounds from the Part 1 design. Hosts enforce them; contracts only name them.
//!
//! Format freeze (owner, 2026-11-28): format v1 of `goat.jsonl` lines and `card.json` freezes at the
//! goat2 merge where lane A's store first writes these files (`cards.sqlite` is a cache and may
//! change freely). Before that, contract changes need no legacy readers. After it, persisted shapes
//! change only additively (new optional fields, new event types that readers skip, see
//! [crate::log::parse_log_line]) or bump the format version with a reader for the old one. The
//! `frozen_v1` test pins a sample log and card file so a breaking change fails CI.

/// Format version written on every `goat.jsonl` line (`v`). Readers understand older versions;
/// the log is never migrated.
pub const LOG_FORMAT_VERSION: u32 = 1;

/// Format version of `card.json` (`CardFile.v`).
pub const CARD_FILE_FORMAT_VERSION: u32 = 1;

/// u64 counters on the wire (seq, cardSeq, generation, sizes, offsets, durations, token counts)
/// stay at or below this so JavaScript numbers are exact. Generated JSON Schemas carry it as
/// `maximum` on every `uint64`.
pub const MAX_SAFE_WIRE_INTEGER: u64 = (1 << 53) - 1;

/// `ThreadCard.title`, in characters (Unicode scalar values).
pub const CARD_TITLE_MAX_CHARS: usize = 200;
/// `ThreadCard.needsYou.summary` and `request.opened.summary`, in characters.
pub const NEEDS_YOU_SUMMARY_MAX_CHARS: usize = 200;
/// `ThreadCard.lastExcerpt`, in characters.
pub const CARD_EXCERPT_MAX_CHARS: usize = 280;
/// `child.reported.summary`, in UTF-8 bytes (8 KB).
pub const CHILD_SUMMARY_MAX_BYTES: usize = 8 * 1024;
/// Item bodies above this many UTF-8 bytes go to `blobs/<itemId>.txt`.
pub const BLOB_THRESHOLD_BYTES: usize = 64 * 1024;

/// Concurrent runs across the host.
pub const MAX_CONCURRENT_RUNS: usize = 4;
/// Concurrent agent process starts.
pub const MAX_CONCURRENT_STARTS: usize = 2;
/// Concurrent children per bot thread.
pub const MAX_CHILDREN_PER_BOT: usize = 4;
/// Child depth. A worker thread may not start another child.
pub const MAX_CHILD_DEPTH: usize = 1;

/// A thread's engine process stops after this many seconds without input.
pub const ENGINE_IDLE_STOP_SECS: u64 = 10 * 60;
/// `collect` follow-ups that arrive within this window become one run.
pub const COLLECT_WINDOW_MS: u64 = 500;
/// Children that report within this window wake the parent once.
pub const CHILD_WAKE_COALESCE_MS: u64 = 500;
/// Subscribers further behind than this many events get a checkpoint snapshot.
pub const REPLAY_MAX_EVENTS: usize = 128;
/// Subscribers further behind than this many bytes get a checkpoint snapshot.
pub const REPLAY_MAX_BYTES: usize = 1024 * 1024;
/// UI connection ping interval.
pub const PING_INTERVAL_SECS: u64 = 30;
/// Agent commands run under `nice -n` this value.
pub const AGENT_NICE: i32 = 10;

/// Memory limit for one thread's engine process group (8 GiB); over it, only that thread stops.
pub const ENGINE_GROUP_MEMORY_LIMIT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// How often the host samples engine process-group memory.
pub const ENGINE_MEMORY_SAMPLE_SECS: u64 = 10;
/// Warn when a process group passes this share of [ENGINE_GROUP_MEMORY_LIMIT_BYTES].
pub const ENGINE_MEMORY_WARN_PERCENT: u8 = 80;

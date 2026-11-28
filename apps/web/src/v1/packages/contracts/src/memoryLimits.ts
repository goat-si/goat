export const MEMORY_CONTEXT_MAX_CHARS = 6000;
export const MEMORY_CONTEXT_MAX_UTF8_BYTES = 24 * 1024;
export const MEMORY_CONTEXT_OUTER_FRAME = "<external_goat_memory></external_goat_memory>";
export const MEMORY_PAGE_MAX_ITEMS = 100;
export const MEMORY_PAGE_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_TAIL_ADMISSION_BYTES = MEMORY_PAGE_MAX_UTF8_BYTES - 2048;
export const MEMORY_PAYLOAD_MAX_UTF8_BYTES = 64 * 1024;
export const MEMORY_DEFERRED_SWEEP_MAX_ITEMS = 256;
export const MEMORY_DEFERRED_SWEEP_MAX_BYTES = 8 * 1024 * 1024;
export const MEMORY_BODY_MAX_UTF8_BYTES = 16384;
export const MEMORY_DERIVED_REVISIONS_MAX_V1 = 100;
export const MEMORY_DERIVED_REVISIONS_MAX = 1000;
export const MEMORY_THREAD_LINEAGE_MAX = 1000;
export const MEMORY_USER_MAX_ITEMS = 2000;
export const MEMORY_PROJECT_MAX_ITEMS = 2000;
export const MEMORY_THREAD_MAX_SUMMARIES = 1;
export const MEMORY_THREAD_MAX_EXPLICIT_ITEMS = 100;
export const MEMORY_SPACE_MAX_LIVE_ITEMS = 20000;
export const MEMORY_ENVIRONMENT_MAX_LIVE_ITEMS = 20000;
export const MEMORY_LIVE_MAX_PAYLOAD_BYTES = 134217728;
export const MEMORY_SUBSTRING_MAX_ITEMS = 2000;
export const MEMORY_SUBSTRING_MAX_UTF8_BYTES = 8388608;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_BODY_BYTES = 33554432;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_ITEMS = 5000;
export const MEMORY_TRIGRAM_EXPERIMENT_MAX_ALLOCATED_BYTES = 67108864;
export const MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES = 8388608;
export const MEMORY_IMPORT_PREVIEW_MAX_ITEMS = 128;
export const MEMORY_IMPORT_APPLY_MAX_ITEMS = 32;
export const MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS = 128;
export const MEMORY_IMPORT_SESSION_MAX_BODY_BYTES = 2097152;
export const MEMORY_IMPORT_MAX_LIVE_ITEMS = 10000;
export const MEMORY_IMPORT_MAX_LIVE_BODY_BYTES = 67108864;
export const MEMORY_IMPORT_MAX_SOURCE_ITEMS = 50000;
export const MEMORY_IMPORT_MAX_ALIASES = 100000;
export const MEMORY_IMPORT_MAX_CONTENT_DIGESTS = 100000;
export const MEMORY_IMPORT_LINEAGE_MAX_RECORDS_PER_MEMORY = 1000;
export const MEMORY_IMPORT_LINEAGE_MAX_BYTES = 33554432;
export const MEMORY_IMPORT_KEY_MAX_UTF8_BYTES = 512;
export const MEMORY_IMPORT_DIGEST_MAX_UTF8_BYTES = 64;
export const MEMORY_REVERT_WINDOW_MS = 2592000000;
export const MEMORY_REPLACED_PAYLOAD_RETENTION_MS = 2592000000;
export const MEMORY_RESOLUTION_PAYLOAD_RETENTION_MS = 2592000000;
export const MEMORY_HISTORY_MAX_PAYLOAD_BYTES = 134217728;
export const MEMORY_CHECKPOINT_INTERVAL_MS = 86400000;
export const MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS = 10000;
export const MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES = 33554432;
export const MEMORY_LOG_RETENTION_MS = 2592000000;
export const MEMORY_LOG_MAX_TAIL_ROWS = 50000;
export const MEMORY_LOG_MAX_TAIL_BYTES = 67108864;
export const MEMORY_CANONICAL_STAGING_MAX_BYTES = 536870912;

export const MEMORY_LEGACY_LINEAGE_GUIDANCE =
  "This conversation has incomplete memory provenance and cannot save new memories. Start a new conversation to save this memory.";
export const MEMORY_LINEAGE_GUIDANCE =
  "This conversation's memory history is incomplete. Ask the person to say the exact words to remember, or they can accept your suggestion in Settings → Memory.";
export const MEMORY_HUB_UPGRADE_GUIDANCE =
  "Other machines in the memory hub need updating before this memory can be saved.";

export const MEMORY_FTS_INDEXED_TEXT_MAX_BYTES = 134217728;
export const MEMORY_FTS_ALLOCATED_WARNING_BYTES = 100663296;
export const MEMORY_FTS_ALLOCATED_BRAKE_BYTES = 134217728;
export const MEMORY_FTS_ALLOCATED_RESUME_BYTES = 100663296;
/**
 * Steady-state ceiling for every memory_* btree on one server, measured with dbstat. Local
 * writes that add content are refused at or above it; forgetting always proceeds.
 */
export const MEMORY_STORE_BUDGET_BYTES = 104857600;
/** Where a healthy memory store sits. Storage samples above it log a warning. */
export const MEMORY_STORE_TARGET_BYTES = 52428800;
/**
 * Default ceiling for orchestration history: the state database minus memory and free pages.
 * While history is above it, compaction trims bulky tool output in idle threads. Configurable
 * as `storageCleanup.historyBudgetBytes`.
 */
export const ORCHESTRATION_HISTORY_BUDGET_BYTES = 2147483648;
/** Threads untouched this long are eligible for trimming while history is over its budget. */
export const ORCHESTRATION_HISTORY_TRIM_IDLE_MS = 604800000;
/** Bulky history fields above this are cut to a head and tail that fit it, marker included. */
export const ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES = 8192;
/**
 * Default idle days after which a thread's turn items move to a compressed archive file and
 * come back when the thread is read. Configurable as `storageCleanup.historyArchiveAfterDays`.
 */
export const ORCHESTRATION_HISTORY_ARCHIVE_AFTER_DAYS = 30;
export const MEMORY_STORAGE_SAMPLE_MAX_DAYS = 30;
export const MEMORY_STORAGE_SAMPLE_MAX_UTF8_BYTES = 16384;
export const MEMORY_STORAGE_SAMPLE_MAX_TABLES = 64;

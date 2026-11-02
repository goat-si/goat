import * as M from "@goat/contracts";

// Producer framing: 36-byte UUID, 64-byte hash cursors/boundary, six safe integers,
// ten array names/brackets and booleans use < 1024 bytes. 4096 additionally covers
// the pull envelope and the separating commas of a page's at most 100 records.
export const CHECKPOINT_PAGE_OVERHEAD = 4096;
const PAGE_RECORDS = 100;
/** MemoryHubPullResult's encoded limit; MemoryHubCheckpointBound.test.ts pins it. */
export const CHECKPOINT_PULL_MAX_BYTES = 262144;
const PAGE_RECORD_BYTES = CHECKPOINT_PULL_MAX_BYTES - CHECKPOINT_PAGE_OVERHEAD;

// Pages close at 100 records or when the next record would overflow the pull envelope. A
// size-closed page plus the next page's first record exceeds PAGE_RECORD_BYTES and each record
// joins at most two such sums, so pages <= rows/100 + 2*bytes/PAGE_RECORD_BYTES + 1. Each page
// adds at most OVERHEAD to its literal records, which `bytes` and `rows` bound.
export const checkpointPages = (bytes: number, rows: number) =>
  Math.floor(rows / PAGE_RECORDS) + Math.floor((2 * bytes) / PAGE_RECORD_BYTES) + 1;
export const checkpointBound = (bytes: number, rows: number) =>
  bytes + checkpointPages(bytes, rows) * CHECKPOINT_PAGE_OVERHEAD;
/** checkpointBound over SQLite integer expressions; both operands are non-negative integers. */
export const checkpointBoundSql = (bytes: string, rows: string) =>
  `(${bytes}+${CHECKPOINT_PAGE_OVERHEAD}*((${rows})/${PAGE_RECORDS}+(2*(${bytes}))/${PAGE_RECORD_BYTES}+1))`;

// A forget swaps live records for a stripped forgotten item, tombstone and compact receipt, each
// with one environment id (FORGET_RECORDS_MAX_BYTES covers ids within the core bound, pinned by
// MemoryHubCheckpointBound.test.ts), plus suppressions the local forget keeps within reserve_bytes
// minus the core. Removed live records are not credited, so live + reserve bounds the result.
export const FORGET_RECORDS_MAX_BYTES = 6 * M.MEMORY_IDENTITY_CORE_MAX_BYTES;
export const futureForgetReserve = (reserveBytes: number, keys: number) => ({
  bytes: Math.max(0, reserveBytes - M.MEMORY_IDENTITY_CORE_MAX_BYTES) + FORGET_RECORDS_MAX_BYTES,
  rows: keys + 8,
});

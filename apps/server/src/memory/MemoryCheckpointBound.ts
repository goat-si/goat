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
// holding the deleting environment id once: 6 KiB covers them for ids within the core bound
// (MemoryHubCheckpointBound.test.ts) and longer legacy member ids add their excess three times.
// Suppressions come from reserve_bytes minus the core; removed live records are not credited.
export const FORGET_RECORDS_MAX_BYTES = 6 * M.MEMORY_IDENTITY_CORE_MAX_BYTES;
const encodedBytes = (environmentId: string) =>
  new TextEncoder().encode(JSON.stringify(environmentId)).length;
/** New hub members must fit the core bound; existing longer ids are charged by futureForgetReserve. */
export const environmentIdFitsForgetRecords = (environmentId: string) =>
  encodedBytes(environmentId) <= M.MEMORY_IDENTITY_CORE_MAX_BYTES;
/** Encoded bytes of the longest environment id that may delete in a space. */
export const deletingEnvironmentBytes = (environmentIds: Iterable<string>) =>
  Math.max(M.MEMORY_IDENTITY_CORE_MAX_BYTES, ...[...environmentIds].map(encodedBytes));
export const futureForgetReserve = (
  reserveBytes: number,
  keys: number,
  environmentBytes: number = M.MEMORY_IDENTITY_CORE_MAX_BYTES,
) => ({
  bytes:
    Math.max(0, reserveBytes - M.MEMORY_IDENTITY_CORE_MAX_BYTES) +
    FORGET_RECORDS_MAX_BYTES +
    3 * Math.max(0, environmentBytes - M.MEMORY_IDENTITY_CORE_MAX_BYTES),
  rows: keys + 8,
});

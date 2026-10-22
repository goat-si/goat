import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  checkpointInventorySize,
  validateCheckpointInventory,
  selectCheckpointMemory,
  selectCheckpointReceipt,
  selectCheckpointIndependent,
  measureCheckpointRevisionHistory,
} from "./MemoryCheckpointInventory.ts";
import { futureForgetReserve } from "./MemoryCheckpointBound.ts";

const noLineage: ReadonlySet<M.MemoryRevisionId> = new Set();

const decodeSpace = Schema.decodeUnknownEffect(M.MemorySpaceId);
const decodeMemory = Schema.decodeUnknownEffect(M.MemoryId);

export class CheckpointAccountingError extends Schema.TaggedError<CheckpointAccountingError>()(
  "CheckpointAccountingError",
  { stage: Schema.String },
) {}

/** Check only addressed lifecycle rows; an absent triple still permits first initialization. */
const validateCheckpointLifecycles = Effect.fnUntraced(function* (spaces: Iterable<string>) {
  const sql = yield* SqlClient.SqlClient;
  for (const space of spaces) {
    const totals = yield* sql<{
      dimension: string;
      value: number;
    }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows')`;
    if (
      totals.length > 0 &&
      (totals.length !== 3 ||
        totals.find((row) => row.dimension === "checkpoint_initialized")?.value !== 1)
    )
      return yield* new CheckpointAccountingError({ stage: "missing-total" });
  }
});

/** Synchronous counter-cache invalidations, never asynchronous work or a corpus index.
 * The reserved space is the existing counters' PK prefix, so reading touched keys
 * does not scan the corpus or all cached counters. Refresh and delta commit together.
 */
export const refreshCheckpointAccounting = Effect.fnUntraced(function* (
  /** Migrations that run before revisions carry `checkpoint_bytes` decode every revision instead. */
  revisionSizes: "cached" | "recompute" = "cached",
) {
  const sql = yield* SqlClient.SqlClient;
  const pendingLifecycle = sql<{
    dimension: string;
  }>`SELECT dimension FROM memory_quota_counters WHERE space='_checkpoint_lifecycle' AND scope_key=''`;
  const pending = yield* pendingLifecycle;
  const dirty = yield* sql<{
    dimension: string;
    scope_key: string;
  }>`SELECT dimension,scope_key FROM memory_quota_counters WHERE space='_checkpoint_dirty'`;
  // Validate before initialization or deltas can obscure a missing marker/total.
  // Migration 083 seeds the baseline once; its triggers retain later lifecycle changes.
  yield* validateCheckpointLifecycles(
    new Set([...pending.map((row) => row.dimension), ...dirty.map((key) => key.dimension)]),
  );
  const now = yield* Clock.currentTimeMillis;
  for (const key of dirty) {
    const memory = key.scope_key.startsWith("m:");
    const id = key.scope_key.slice(2);
    if (memory) {
      const canonical =
        yield* sql`SELECT 1 FROM memory_identity_ledger WHERE space=${key.dimension} AND memory_id=${id}`;
      if (!canonical.length) {
        // Local drafts have no canonical identity and cannot appear in a hub checkpoint.
        yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_dirty' AND dimension=${key.dimension} AND scope_key=${key.scope_key}`;
        continue;
      }
    }
    const space = yield* decodeSpace(key.dimension);
    const initialized =
      yield* sql`SELECT 1 FROM memory_quota_counters WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`;
    if (!initialized.length) {
      // Only the first canonical write may create zero totals. Never upsert a lost
      // total with a new record's delta after a space has been initialized.
      const orphan =
        yield* sql`SELECT 1 FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') LIMIT 1`;
      if (orphan.length) return yield* new CheckpointAccountingError({ stage: "missing-total" });
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES
        (${space},'hub_snapshot_bytes','',0),(${space},'hub_snapshot_rows','',0),(${space},'checkpoint_initialized','',1)`;
    }
    const independent = key.scope_key.startsWith("l:") || key.scope_key.startsWith("s:");
    const memoryId = memory ? yield* decodeMemory(id) : undefined;
    const cachedSizes = revisionSizes === "cached";
    // Cached sizes cover the history; only the revisions admission selects are decoded here.
    const inventory = memoryId
      ? yield* selectCheckpointMemory(
          space,
          memoryId,
          now,
          false,
          cachedSizes ? noLineage : undefined,
        )
      : independent
        ? yield* selectCheckpointIndependent(space, undefined, {
            kind: key.scope_key.startsWith("l:") ? "l" : "s",
            rowid: id,
          })
        : yield* selectCheckpointReceipt(space, id);
    yield* validateCheckpointInventory(space, inventory);
    const size = checkpointInventorySize(inventory);
    if (memoryId && cachedSizes && inventory.identities.length && !inventory.tombstones.length) {
      const history = yield* measureCheckpointRevisionHistory(
        space,
        memoryId,
        inventory.revisions.map(({ revision }) => revision.revisionId),
      );
      size.bytes += history.bytes;
      size.rows += history.rows;
    }
    if (memory) {
      const reserves = yield* sql<{
        reserve_bytes: number;
        reserve_keys: number;
      }>`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger i WHERE space=${space} AND memory_id=${id} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)`;
      if (reserves[0]) {
        const reserve = futureForgetReserve(reserves[0].reserve_bytes, reserves[0].reserve_keys);
        size.bytes += reserve.bytes;
        size.rows += reserve.rows;
      }
    }
    const table = memory
      ? "memory_identity_ledger"
      : key.scope_key.startsWith("c:")
        ? "memory_compact_receipts"
        : key.scope_key.startsWith("l:")
          ? "memory_import_lineage"
          : "memory_import_keys";
    const column = memory ? "memory_id" : key.scope_key.startsWith("c:") ? "operation_id" : "rowid";
    const cached = yield* sql.unsafe<{ checkpoint_bytes: number; checkpoint_rows: number }>(
      `SELECT checkpoint_bytes,checkpoint_rows FROM ${table} WHERE space=? AND ${column}=?`,
      [space, id],
    );
    for (const [dimension, value] of [
      ["hub_snapshot_bytes", size.bytes],
      ["hub_snapshot_rows", size.rows],
    ] as const) {
      const previous =
        (dimension === "hub_snapshot_bytes"
          ? cached[0]?.checkpoint_bytes
          : cached[0]?.checkpoint_rows) ?? 0;
      const delta = value - previous;
      const updated =
        yield* sql`UPDATE memory_quota_counters SET value=value+${delta} WHERE space=${space} AND dimension=${dimension} AND scope_key='' RETURNING value`;
      if (!updated.length) return yield* new CheckpointAccountingError({ stage: "missing-total" });
    }
    if (cached.length)
      yield* sql.unsafe(
        `UPDATE ${table} SET checkpoint_bytes=?,checkpoint_rows=? WHERE space=? AND ${column}=?`,
        [size.bytes, size.rows, space, id],
      );
    yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_dirty' AND dimension=${space} AND scope_key=${key.scope_key}`;
  }
  // First writes create lifecycle addresses during the loop. Validate those and
  // drain only after every candidate passed; a failed transaction retains its evidence.
  const remaining = yield* pendingLifecycle;
  yield* validateCheckpointLifecycles(remaining.map((row) => row.dimension));
  yield* sql`DELETE FROM memory_quota_counters WHERE space='_checkpoint_lifecycle' AND scope_key=''`;
  // Marker and recalculated counters become visible together on migration commit.
  const initialized = yield* sql<{
    value: number;
  }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='checkpoint_codec' AND scope_key=''`;
  if (initialized[0]?.value !== 1)
    return yield* new CheckpointAccountingError({ stage: "uninitialized" });
});

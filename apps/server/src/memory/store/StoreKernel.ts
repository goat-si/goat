import { CHECKPOINT_PAGE_OVERHEAD } from "../MemoryCheckpointBound.ts";
import { refreshCheckpointAccounting } from "../MemoryCheckpointAccounting.ts";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, stored } from "./StoreCodecs.ts";
import { MemoryCapacityError, MemoryStorageError, Transaction } from "./StoreModel.ts";

export const makeStoreKernel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lane = yield* Semaphore.make(1);
  let signals = yield* PubSub.dropping<M.MemoryChangeSignal>(256);
  const wakes = yield* PubSub.sliding<void>(1);
  const wake = PubSub.publish(wakes, undefined).pipe(Effect.asVoid);
  // oxlint-disable-next-line goat/prefer-effect-fn -- Moved verbatim from MemoryStore.ts, which predates this rule; Effect.fn would add a span.
  const transact = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: { requireOuter?: boolean; finalGuard?: Effect.Effect<void, E> },
  ): Effect.Effect<A, E | MemoryStorageError, Exclude<R, Transaction>> =>
    Effect.gen(function* () {
      const existing = yield* Effect.serviceOption(Transaction);
      if (Option.isSome(existing)) {
        if (options?.requireOuter || options?.finalGuard)
          return yield* new MemoryStorageError({ stage: "nested-admission", cause: undefined });
        return yield* Effect.provideService(effect, Transaction, existing.value);
      }
      return yield* lane.withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const journal = { signals: [] as M.MemoryChangeSignal[], runnable: false };
            const result = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  // SQLite's write lock must precede membership reads and the authoritative clock.
                  yield* sql`UPDATE memory_quota_counters SET value=value WHERE 0`;
                  const result = yield* restore(effect).pipe(
                    Effect.provideService(Transaction, journal),
                  );
                  yield* stored(
                    "checkpoint-accounting",
                    refreshCheckpointAccounting().pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    ),
                  );
                  // SQL-free authority check after every accounting statement, before COMMIT.
                  if (options?.finalGuard) yield* options.finalGuard;
                  return result;
                }),
              )
              .pipe(
                Effect.mapError((cause) =>
                  isSqlError(cause)
                    ? new MemoryStorageError({ stage: "transaction", cause })
                    : (cause as E),
                ),
              );
            if (!(yield* PubSub.publishAll(signals, journal.signals))) {
              yield* PubSub.shutdown(signals);
              signals = yield* PubSub.dropping<M.MemoryChangeSignal>(256);
            }
            if (journal.runnable) yield* wake;
            return result;
          }),
        ),
      );
    });
  const globalHubCounters = Effect.fnUntraced(function* () {
    return yield* stored(
      "hub-global-counters",
      sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND scope_key=''`,
    );
  });
  const globalCheckpointReservation = Effect.fnUntraced(function* () {
    yield* stored(
      "checkpoint-accounting",
      refreshCheckpointAccounting().pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
    const rows = yield* stored(
      "hub-checkpoint-bound-global",
      sql<{ bytes: number; bound: number }>`
      SELECT coalesce(sum(max(coalesce(r.checkpoint_bytes,0),
        coalesce(b.value,0)+max(1,coalesce(n.value,0))*${CHECKPOINT_PAGE_OVERHEAD})+
        coalesce(r.published_pinned_bytes,0)-CASE WHEN r.checkpoint_id IS NOT r.reserved_snapshot_id AND NOT EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE json_extract(h.value,'$.checkpointId')=r.reserved_snapshot_id) AND r.snapshot_generation=coalesce(g.value,0) AND EXISTS(SELECT 1 FROM memory_inbox_pending p WHERE p.space=r.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||r.reserved_snapshot_id) THEN min(r.last_snapshot_bytes,r.published_pinned_bytes) ELSE 0 END),0) AS bytes,
      coalesce(sum(coalesce(b.value,0)+max(1,coalesce(n.value,0))*${CHECKPOINT_PAGE_OVERHEAD}),0) AS bound
      FROM (SELECT space FROM memory_hub_retention UNION SELECT space FROM memory_quota_counters WHERE dimension='hub_snapshot_rows' AND scope_key='') s
      LEFT JOIN memory_hub_retention r ON r.space=s.space
      LEFT JOIN memory_quota_counters b ON b.space=s.space AND b.dimension='hub_snapshot_bytes' AND b.scope_key=''
      LEFT JOIN memory_quota_counters n ON n.space=s.space AND n.dimension='hub_snapshot_rows' AND n.scope_key=''
      LEFT JOIN memory_quota_counters g ON g.space=s.space AND g.dimension='hub_snapshot_generation' AND g.scope_key=''`,
    );
    return rows[0]!;
  });
  // oxlint-disable-next-line goat/prefer-effect-fn -- Moved verbatim from MemoryStore.ts, which predates this rule; Effect.fn would add a span.
  const withHubBudget = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const before = new Map((yield* globalHubCounters()).map((row) => [row.dimension, row.value]));
      const beforeCheckpoint = yield* globalCheckpointReservation();
      before.set("hub_checkpoint", beforeCheckpoint.bytes + (before.get("import_staging") ?? 0));
      const result = yield* effect;
      const after = new Map((yield* globalHubCounters()).map((row) => [row.dimension, row.value]));
      const afterCheckpoint = yield* globalCheckpointReservation();
      // A larger explicit reservation must not hide a new request's incremental input growth.
      const maskedGrowth = Math.max(
        0,
        afterCheckpoint.bound -
          beforeCheckpoint.bound -
          Math.max(0, afterCheckpoint.bytes - beforeCheckpoint.bytes),
      );
      after.set(
        "hub_checkpoint",
        afterCheckpoint.bytes + maskedGrowth + (after.get("import_staging") ?? 0),
      );
      before.set(
        "import_source_items",
        (before.get("import_source_items") ?? 0) + (before.get("import_sources") ?? 0),
      );
      after.set(
        "import_source_items",
        (after.get("import_source_items") ?? 0) + (after.get("import_sources") ?? 0),
      );
      for (const [counter, dimension, limit] of [
        ["import_source_items", "import_source_items", M.MEMORY_IMPORT_MAX_SOURCE_ITEMS],
        ["import_aliases", "import_aliases", M.MEMORY_IMPORT_MAX_ALIASES],
        ["import_digests", "import_digests", M.MEMORY_IMPORT_MAX_CONTENT_DIGESTS],
        ["import_live_items", "import_live_items", M.MEMORY_IMPORT_MAX_LIVE_ITEMS],
        ["import_live_bytes", "import_live_bytes", M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES],
        ["hub_metadata", "permanent_metadata", M.MEMORY_PERMANENT_METADATA_MAX_BYTES],
        ["hub_receipts", "receipts", M.MEMORY_DEDUP_MAX_RECEIPTS],
        ["hub_ids", "lifetime_ids", M.MEMORY_MAX_LIFETIME_IDS],
        ["hub_keys", "import_source_items", M.MEMORY_IMPORT_MAX_SOURCE_ITEMS],
        ["hub_checkpoint", "checkpoint_staging", M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES],
      ] as const) {
        const current = after.get(counter);
        if (
          counter.startsWith("import_") &&
          current === undefined &&
          before.get(counter) === undefined
        )
          continue;
        if (current === undefined || before.get(counter) === undefined)
          return yield* new MemoryStorageError({
            stage: "hub-counters-uninitialized",
            cause: undefined,
          });
        // Approved replica state may be over local limits. Cleanup/replay that does not grow it stays possible.
        if (current > limit && current > before.get(counter)!)
          return yield* new MemoryCapacityError({ dimension, current, limit });
      }
      return result;
    });
  const nextWatermark = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "projection-watermark",
      sql<{
        projection_watermark: number;
      }>`INSERT INTO memory_compaction_state (space,projection_watermark) VALUES (${space},1) ON CONFLICT(space) DO UPDATE SET projection_watermark=projection_watermark+1 RETURNING projection_watermark`,
    );
    return rows[0]!.projection_watermark;
  });
  const emit = Effect.fnUntraced(function* (signal: M.MemoryChangeSignal) {
    const tx = yield* Effect.serviceOption(Transaction);
    if (Option.isNone(tx)) return yield* Effect.die("Memory write requires transaction ownership");
    tx.value.signals.push(signal);
  });
  const markRunnable = Effect.gen(function* () {
    const tx = yield* Effect.serviceOption(Transaction);
    if (Option.isSome(tx)) tx.value.runnable = true;
    else yield* wake;
  });
  const changes = Effect.fn("MemoryStore.changes")(function* (space: M.MemorySpaceId) {
    const subscription = yield* PubSub.subscribe(signals);
    const rows = yield* stored(
      "watermark",
      sql<{
        watermark: number;
      }>`SELECT coalesce(max(projection_watermark),0) AS watermark FROM memory_compaction_state WHERE space=${space}`,
    );
    const watermark = rows[0]!.watermark;
    return Stream.concat(
      Stream.succeed<M.MemoryChangeSignal>({
        memorySpaceId: space,
        projectionWatermark: watermark,
        kind: "reset",
      }),
      Stream.fromSubscription(subscription).pipe(
        Stream.filter(
          (signal) =>
            signal.memorySpaceId === space &&
            (signal.kind === "reset" || signal.projectionWatermark > watermark),
        ),
      ),
    );
  });
  const counters = Effect.fn("MemoryStore.counters")(function* (space: string) {
    return yield* stored(
      "counters",
      sql<{
        dimension: string;
        scope_key: string;
        value: number;
      }>`SELECT dimension,scope_key,value FROM memory_quota_counters WHERE space=${space}`,
    );
  });
  return {
    sql,
    wake,
    transact,
    globalHubCounters,
    withHubBudget,
    nextWatermark,
    emit,
    markRunnable,
    changes,
    counters,
    subscribeWake: Effect.map(PubSub.subscribe(wakes), Stream.fromSubscription),
  };
});

export type StoreKernel = Effect.Success<typeof makeStoreKernel>;

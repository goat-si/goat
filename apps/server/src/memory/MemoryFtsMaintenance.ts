import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Metrics from "../observability/Metrics.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";

/**
 * How often an unchanged store is re-measured. The worker calls cycle on every sweep, and a
 * sample reads every memory btree, so an idle server must not pay for it per sweep.
 */
export const MEMORY_STORAGE_SAMPLE_INTERVAL_MS = 3_600_000;
/** Resample interval while the store is over budget, so the admission brake releases promptly. */
export const MEMORY_STORAGE_OVER_BUDGET_SAMPLE_INTERVAL_MS = 300_000;

/** Footprint areas for the size metric: what is injected, how it is found, and its machinery. */
const storageArea = (table: M.MemoryStorageTable) => {
  switch (table) {
    case "memory_items":
    case "memory_payloads":
    case "memory_revisions":
    case "memory_tombstones":
    case "memory_identity_ledger":
      return "content";
    case "memory_items_fts":
      return "search";
    case "memory_outbox":
    case "memory_report_outbox":
    case "memory_inbox_pending":
      return "work";
    case "memory_events":
    case "memory_hub_operations":
    case "memory_compact_receipts":
    case "memory_import_receipts":
    case "memory_import_keys":
    case "memory_import_lineage":
      return "log";
    default:
      return "other";
  }
};

export class MemoryFtsMaintenance extends Context.Service<
  MemoryFtsMaintenance,
  {
    readonly cycle: (
      environmentId: M.EnvironmentId,
    ) => Effect.Effect<M.MemoryFtsAdmissionStatus, Store.MemoryStorageError>;
    readonly status: (
      environmentId: M.EnvironmentId,
    ) => Effect.Effect<M.MemoryFtsAdmissionStatus, Store.MemoryStorageError>;
    readonly markChanged: (
      environmentId: M.EnvironmentId,
      changes: number,
    ) => Effect.Effect<void, Store.MemoryStorageError>;
    readonly repair: (
      target: Store.MemoryIndexTarget,
    ) => Effect.Effect<boolean, Store.MemoryStorageError | Store.MemoryCapacityError>;
  }
>()("goat/memory/MemoryFtsMaintenance") {}
const admissionStatus = (state: Store.MemoryFtsState): M.MemoryFtsAdmissionStatus => ({
  state: state.state,
  changedAtUtc:
    state.changedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(state.changedAt)),
  lastMeasuredAtUtc:
    state.measuredAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(state.measuredAt)),
  allocatedBytes: state.allocatedBytes,
  measurementStatus: state.measurementStatus,
});
const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const quota = yield* Quota.MemoryQuotaService;
  // Completed cycles, including ones whose measurement was unavailable, so a missing dbstat is
  // not retried on every sweep. A cycle that fails is not recorded and stays visible.
  const lastSampleAttempt = new Map<M.EnvironmentId, number>();
  const overBudget = new Set<M.EnvironmentId>();
  const status = Effect.fn("MemoryFtsMaintenance.status")(function* (
    environmentId: M.EnvironmentId,
  ) {
    return admissionStatus(yield* store.ftsState(environmentId));
  });
  const markChanged = Effect.fn("MemoryFtsMaintenance.markChanged")(function* (
    environmentId: M.EnvironmentId,
    changes: number,
  ) {
    yield* store.transact(
      Effect.gen(function* () {
        const state = yield* store.ftsState(environmentId);
        yield* store.putFtsState({
          ...state,
          changedRows: Math.min(state.changedRows + Math.max(0, Math.floor(changes)), 2147483647),
          mergePending: state.mergePending || changes >= M.MEMORY_FTS_MERGE_TRIGGER_CHANGES,
        });
      }),
    );
  });
  const cycle = Effect.fn("MemoryFtsMaintenance.cycle")(function* (environmentId: M.EnvironmentId) {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* store.ftsState(environmentId);
    const lastAttempt = lastSampleAttempt.get(environmentId);
    const interval = overBudget.has(environmentId)
      ? MEMORY_STORAGE_OVER_BUDGET_SAMPLE_INTERVAL_MS
      : MEMORY_STORAGE_SAMPLE_INTERVAL_MS;
    const sampleDue =
      lastAttempt === undefined ||
      previous.measuredAt === null ||
      now - Math.max(lastAttempt, previous.measuredAt) >= interval;
    const mergeWanted =
      previous.mergePending ||
      previous.changedRows >= M.MEMORY_FTS_MERGE_TRIGGER_CHANGES ||
      (previous.changedRows > 0 &&
        (previous.lastMergeAt ?? 0) + M.MEMORY_FTS_MERGE_INTERVAL_MS <= now);
    if (!sampleDue && !mergeWanted) return admissionStatus(previous);
    const measured = yield* store.measureAllocation();
    const bytes = measured.ftsBytes;
    const braked =
      previous.state === "braked" ||
      (bytes !== null && bytes >= M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES);
    const needed = mergeWanted || (bytes !== null && bytes >= M.MEMORY_FTS_ALLOCATED_WARNING_BYTES);
    let state: Store.MemoryFtsState = {
      ...previous,
      state: braked ? "braked" : "open",
      changedAt: previous.state === (braked ? "braked" : "open") ? previous.changedAt : now,
      allocatedBytes: bytes,
      measurementStatus: bytes === null ? "unavailable" : "available",
      measuredAt: bytes === null ? previous.measuredAt : now,
      mergePending: needed,
    };
    // Persist the sampled brake before publishing any refreshed status or starting repair.
    yield* store.putFtsState(state);
    let sampled = measured;
    if (needed && (yield* store.mergeFts())) {
      const after = yield* store.measureAllocation();
      sampled = after;
      const canResume =
        after.ftsBytes !== null && after.ftsBytes < M.MEMORY_FTS_ALLOCATED_RESUME_BYTES;
      state = {
        ...state,
        state: canResume ? "open" : state.state,
        changedAt: canResume && state.state === "braked" ? now : state.changedAt,
        allocatedBytes: after.ftsBytes,
        measurementStatus: after.ftsBytes === null ? "unavailable" : "available",
        measuredAt: after.ftsBytes === null ? state.measuredAt : now,
        lastMergeAt: now,
        changedRows: 0,
        mergePending:
          after.ftsBytes === null || after.ftsBytes >= M.MEMORY_FTS_ALLOCATED_WARNING_BYTES,
      };
      yield* store.putFtsState(state);
    }
    yield* quota.recordStorageSample(environmentId, undefined, sampled);
    lastSampleAttempt.set(environmentId, now);
    if (sampled.memoryBytes !== null) {
      const areas = new Map<string, number>([["total", sampled.memoryBytes]]);
      for (const table of sampled.tables) {
        const area = storageArea(table.table);
        areas.set(area, (areas.get(area) ?? 0) + (table.allocatedBytes ?? 0));
      }
      for (const [area, bytes] of areas)
        yield* Metric.update(Metric.withAttributes(Metrics.memoryStoreBytes, { area }), bytes);
      if (sampled.memoryBytes >= M.MEMORY_STORE_BUDGET_BYTES) overBudget.add(environmentId);
      else overBudget.delete(environmentId);
      if (sampled.memoryBytes >= M.MEMORY_STORE_TARGET_BYTES)
        yield* Effect.logWarning("Memory store is above its size target", {
          memoryBytes: sampled.memoryBytes,
          targetBytes: M.MEMORY_STORE_TARGET_BYTES,
          budgetBytes: M.MEMORY_STORE_BUDGET_BYTES,
        });
    }
    return admissionStatus(state);
  });
  return MemoryFtsMaintenance.of({ status, cycle, markChanged, repair: store.index });
});
export const layer = Layer.effect(MemoryFtsMaintenance, make);

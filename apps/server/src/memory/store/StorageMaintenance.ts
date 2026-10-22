import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { decodeFtsState, sampleCodec, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { strict } from "./StoreModel.ts";
import type { MemoryFtsState } from "./StoreModel.ts";

export const makeStorageMaintenance = (kernel: Pick<StoreKernel, "sql" | "transact">) => {
  const { sql, transact } = kernel;
  const ftsState = Effect.fn("MemoryStore.ftsState")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "fts-state",
      sql<{
        state: "open" | "braked";
        changed_at: number | null;
        allocated_bytes: number | null;
        measured_at: number | null;
        measurement_status: "available" | "unavailable";
        merge_pending: number;
        changed_rows: number;
        last_merge_at: number | null;
      }>`SELECT * FROM memory_fts_maintenance_state WHERE environment=${environment}`,
    );
    const row = rows[0];
    return row
      ? {
          environment,
          state: row.state,
          changedAt: row.changed_at,
          allocatedBytes: row.allocated_bytes,
          measuredAt: row.measured_at,
          measurementStatus: row.measurement_status,
          mergePending: row.merge_pending === 1,
          changedRows: row.changed_rows,
          lastMergeAt: row.last_merge_at,
        }
      : {
          environment,
          state: "open" as const,
          changedAt: null,
          allocatedBytes: null,
          measuredAt: null,
          measurementStatus: "unavailable" as const,
          mergePending: false,
          changedRows: 0,
          lastMergeAt: null,
        };
  });
  const putFtsState = Effect.fn("MemoryStore.putFtsState")(function* (input: MemoryFtsState) {
    const state = yield* stored("fts-state-codec", decodeFtsState(input, strict));
    yield* stored(
      "fts-state-write",
      sql`INSERT INTO memory_fts_maintenance_state (environment,state,changed_at,allocated_bytes,measured_at,measurement_status,merge_pending,changed_rows,last_merge_at) VALUES (${state.environment},${state.state},${state.changedAt},${state.allocatedBytes},${state.measuredAt},${state.measurementStatus},${state.mergePending ? 1 : 0},${state.changedRows},${state.lastMergeAt}) ON CONFLICT(environment) DO UPDATE SET state=excluded.state,changed_at=excluded.changed_at,allocated_bytes=excluded.allocated_bytes,measured_at=excluded.measured_at,measurement_status=excluded.measurement_status,merge_pending=excluded.merge_pending,changed_rows=excluded.changed_rows,last_merge_at=excluded.last_merge_at`,
    );
  });
  const measureAllocation = Effect.fn("MemoryStore.measureAllocation")(function* () {
    const pages = yield* stored("page-count", sql<{ page_count: number }>`PRAGMA page_count`);
    const size = yield* stored("page-size", sql<{ page_size: number }>`PRAGMA page_size`);
    const free = yield* stored("freelist", sql<{ freelist_count: number }>`PRAGMA freelist_count`);
    // The name constraint lets dbstat walk only memory btrees. Unfiltered, it reads every
    // page of the shared database, which takes seconds once orchestration history is large.
    const tableAllocations = yield* sql<{
      name: string;
      bytes: number;
    }>`SELECT name,sum(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE (type='table' AND name LIKE 'memory_%') OR (type='index' AND tbl_name LIKE 'memory_%')) GROUP BY name`.pipe(
      Effect.option,
    );
    const allocation = Option.isSome(tableAllocations)
      ? {
          memory_bytes: tableAllocations.value.reduce((sum, row) => sum + row.bytes, 0),
          fts_bytes: tableAllocations.value
            .filter((row) => row.name.startsWith("memory_items_fts"))
            .reduce((sum, row) => sum + row.bytes, 0),
        }
      : undefined;
    const tables: M.MemoryStorageTableUsage[] = [];
    for (const table of M.MemoryStorageTable.literals) {
      const exists = yield* stored(
        "table-inventory",
        sql`SELECT 1 FROM sqlite_master WHERE name=${table} AND type='table'`,
      );
      if (!exists.length) continue;
      const rows = yield* stored(
        "table-count",
        sql.unsafe<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
      );
      const indexedNames = yield* stored(
        "table-indexes",
        sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE tbl_name=${table} AND type='index'`,
      );
      const names = new Set([
        table,
        ...indexedNames.map((row) => row.name),
        ...(table === "memory_items_fts"
          ? [
              "memory_items_fts_data",
              "memory_items_fts_idx",
              "memory_items_fts_content",
              "memory_items_fts_docsize",
              "memory_items_fts_config",
            ]
          : []),
      ]);
      const allocated = Option.isSome(tableAllocations)
        ? tableAllocations.value
            .filter((row) => names.has(row.name))
            .reduce((sum, row) => sum + row.bytes, 0)
        : null;
      const columns = yield* stored(
        "table-columns",
        sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`),
      );
      const charged = columns.filter(
        (column) =>
          column.name.endsWith("_json") ||
          column.name === "reserve_bytes" ||
          (table === "memory_items_fts" && column.name === "body"),
      );
      const expression =
        charged
          .map((column) =>
            column.name === "reserve_bytes"
              ? "coalesce(reserve_bytes,0)"
              : `coalesce(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`,
          )
          .join("+") || "0";
      const logical = yield* stored(
        "table-logical",
        sql.unsafe<{ bytes: number }>(
          `SELECT coalesce(sum(${expression}),0) AS bytes FROM ${table}`,
        ),
      );
      tables.push({
        table,
        rowCount: rows[0]!.count,
        logicalBytes: logical[0]!.bytes,
        allocatedBytes: allocated,
        allocationStatus: allocated === null ? "unavailable" : "available",
      });
    }
    return {
      tables,
      memoryBytes: allocation?.memory_bytes ?? null,
      ftsBytes: allocation?.fts_bytes ?? null,
      dbFileBytes: (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0),
      freelistBytes: (free[0]?.freelist_count ?? 0) * (size[0]?.page_size ?? 0),
    };
  });
  const mergeFts = Effect.fn("MemoryStore.mergeFts")(function* () {
    return yield* sql`INSERT INTO memory_items_fts(memory_items_fts,rank) VALUES ('merge',${M.MEMORY_FTS_MERGE_MAX_PAGES})`.pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });
  const measuredMemoryBytes = Effect.fn("MemoryStore.measuredMemoryBytes")(function* (
    environment: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "sample-memory-bytes",
      sql<{
        bytes: number | null;
      }>`SELECT json_extract(current_sample_json,'$.memoryAllocatedBytes') AS bytes FROM memory_compaction_state WHERE space=${`_environment:${environment}`}`,
    );
    return rows[0]?.bytes ?? null;
  });
  // Completion already keeps one completed row per thread and kind. What remains are rows
  // for threads that are gone and cancelled or failed rows behind a newer run. The recovery
  // scan reads only each live thread's newest row, so neither can matter again. A page holds
  // a fixed number of outbox rows, so one call costs the same on any backlog.
  const pruneSettledSummaryWork = Effect.fn("MemoryStore.pruneSettledSummaryWork")(function* (
    environment: M.EnvironmentId,
    afterRowId: number,
    pageRows: number,
  ) {
    const page = yield* stored(
      "summary-work-page",
      sql<{
        last: number | null;
        rows: number;
      }>`SELECT max(rowid) AS last,count(*) AS rows FROM (SELECT rowid FROM memory_outbox WHERE rowid>${afterRowId} ORDER BY rowid LIMIT ${Math.max(1, pageRows)})`,
    );
    const last = page[0]?.last ?? null;
    if (last === null) return { removed: 0, nextRowId: null };
    const removed = yield* stored(
      "summary-work-prune",
      sql<{ id: string }>`DELETE FROM memory_outbox WHERE rowid IN (
        SELECT o.rowid FROM memory_outbox o NOT INDEXED
        WHERE o.rowid>${afterRowId} AND o.rowid<=${last} AND o.kind IN ('summary','consolidate')
        AND o.status IN ('completed','cancelled','failed') AND json_extract(o.metadata_json,'$.kind')='summary'
        AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environment}
        AND (
          NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=json_extract(o.metadata_json,'$.sourceThread.threadId') AND t.deleted_at IS NULL)
          OR (o.status IN ('cancelled','failed') AND EXISTS (
            SELECT 1 FROM memory_outbox n WHERE n.kind IN ('summary','consolidate')
            AND json_extract(n.metadata_json,'$.sourceThread.threadId')=json_extract(o.metadata_json,'$.sourceThread.threadId')
            AND coalesce(json_extract(n.metadata_json,'$.observedThroughSequence'),json_extract(n.metadata_json,'$.sourceWatermark.throughSequence'))
              >coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),json_extract(o.metadata_json,'$.sourceWatermark.throughSequence'))))
        )
      ) RETURNING id`,
    );
    return {
      removed: removed.length,
      nextRowId: (page[0]?.rows ?? 0) < Math.max(1, pageRows) ? null : last,
    };
  });
  const recordSample = Effect.fn("MemoryStore.recordSample")(function* (
    environment: M.EnvironmentId,
    input: M.MemoryStorageSample,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const json = yield* sampleCodec.encode(input);
        const systemSpace = `_environment:${environment}`;
        const rows = yield* stored(
          "sample-current",
          sql<{
            current_sample_json: string | null;
          }>`SELECT current_sample_json FROM memory_compaction_state WHERE space=${systemSpace}`,
        );
        const previous = rows[0]?.current_sample_json
          ? yield* sampleCodec.decode(rows[0].current_sample_json, strict)
          : undefined;
        if (previous && Date.parse(previous.measuredAtUtc) >= Date.parse(input.measuredAtUtc))
          return false;
        if (previous && previous.utcDay !== input.utcDay)
          yield* stored(
            "sample-archive",
            sql`INSERT INTO memory_storage_samples (environment,utc_day,measured_at,sample_json,is_current) VALUES (${environment},${previous.utcDay},${Date.parse(previous.measuredAtUtc)},${yield* sampleCodec.encode(previous)},0) ON CONFLICT(environment,utc_day) DO UPDATE SET measured_at=excluded.measured_at,sample_json=excluded.sample_json`,
          );
        yield* stored(
          "sample-current-write",
          sql`INSERT INTO memory_compaction_state (space,current_sample_json) VALUES (${systemSpace},${json}) ON CONFLICT(space) DO UPDATE SET current_sample_json=excluded.current_sample_json`,
        );
        yield* stored(
          "sample-evict",
          sql`DELETE FROM memory_storage_samples WHERE environment=${environment} AND utc_day NOT IN (SELECT utc_day FROM memory_storage_samples WHERE environment=${environment} ORDER BY utc_day DESC LIMIT ${M.MEMORY_STORAGE_SAMPLE_MAX_DAYS})`,
        );
        return true;
      }),
    );
  });
  const samples = Effect.fn("MemoryStore.samples")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "samples",
      sql<{
        sample_json: string;
      }>`SELECT sample_json FROM memory_storage_samples WHERE environment=${environment} UNION ALL SELECT current_sample_json AS sample_json FROM memory_compaction_state WHERE space=${`_environment:${environment}`} AND current_sample_json IS NOT NULL`,
    );
    const result = yield* Effect.forEach(rows, (row) =>
      sampleCodec.decode(row.sample_json, strict),
    );
    return result.toSorted((a, b) => a.utcDay.localeCompare(b.utcDay));
  });
  return {
    ftsState,
    putFtsState,
    measureAllocation,
    mergeFts,
    measuredMemoryBytes,
    pruneSettledSummaryWork,
    recordSample,
    samples,
  };
};

export type StorageMaintenance = ReturnType<typeof makeStorageMaintenance>;

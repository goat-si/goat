import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeMemoryId, keyCodec, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";

const decodeThreadId = Schema.decodeEffect(M.ThreadId);
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const MEMORY_RECALL_SCAN_MAX_ITEMS = 2000;
const MEMORY_RECALL_MAX_RELATED_THREADS = 2000;

export const makeRecallStore = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  const relatedThreads = Effect.fn("MemoryStore.recallRelatedThreads")(function* (
    space: M.MemorySpaceId,
    environmentId: M.EnvironmentId,
    projectKey: M.MemoryProjectKey,
    caller: M.ThreadId,
  ) {
    const key = yield* stored("recall-key", keyCodec.encode(projectKey));
    const rows = yield* stored(
      "recall-related-threads",
      sql<{ thread_id: string }>`
      SELECT t.thread_id FROM orchestration_v2_projection_threads t
      JOIN memory_project_bindings b ON b.project_id=t.project_id
      WHERE b.memory_space_id=${space} AND b.environment_id=${environmentId}
        AND b.project_key_json=${key} AND t.deleted_at IS NULL AND t.thread_id<>${caller}
      ORDER BY t.updated_at DESC,t.thread_id DESC LIMIT 2001`,
    );
    const threadPrefix = `thread:${environmentId.length}:${environmentId}:`;
    const unresolved = yield* stored(
      "recall-unresolved-projects",
      sql<{ missing: number }>`SELECT EXISTS(
        SELECT 1 FROM orchestration_v2_projection_threads t
        JOIN memory_items i ON i.space=${space} AND i.scope_key=${threadPrefix}||t.thread_id
        LEFT JOIN memory_project_bindings b ON b.memory_space_id=${space}
          AND b.environment_id=${environmentId} AND b.project_id=t.project_id
        WHERE t.deleted_at IS NULL AND i.status='active' AND b.project_key_json IS NULL
      ) AS missing`,
    );
    return {
      threads: yield* Effect.forEach(rows.slice(0, MEMORY_RECALL_MAX_RELATED_THREADS), (row) =>
        stored("recall-thread-id", decodeThreadId(row.thread_id)),
      ),
      truncated: rows.length > MEMORY_RECALL_MAX_RELATED_THREADS,
      unresolvedProjects: unresolved[0]?.missing === 1,
    };
  });
  const recallCoverage = Effect.fn("MemoryStore.recallCoverage")(function* (
    space: M.MemorySpaceId,
    keys: ReadonlyArray<string>,
  ) {
    const keysJson = yield* stored("recall-keys", encodeKeys(keys));
    const rows = yield* stored(
      "recall-coverage",
      sql<{ eligible: number; indexed: number; watermark: number }>`
      SELECT coalesce(sum(eligible),0) AS eligible,coalesce(sum(indexed),0) AS indexed,
        coalesce((SELECT projection_watermark FROM memory_compaction_state WHERE space=${space}),0) AS watermark
      FROM memory_search_counters WHERE space=${space} AND scope_key IN (SELECT value FROM json_each(${keysJson}))`,
    );
    return rows[0] ?? { eligible: 0, indexed: 0, watermark: 0 };
  });
  const recallCandidates = Effect.fn("MemoryStore.recallCandidates")(function* (
    space: M.MemorySpaceId,
    keys: ReadonlyArray<string>,
    match: string,
  ) {
    const keysJson = yield* stored("recall-keys", encodeKeys(keys));
    const rows = yield* stored(
      "recall-candidates",
      sql<{ memory_id: string; scope_key: string; rank: number | null }>`
      WITH window AS MATERIALIZED (
        SELECT rowid,memory_id,scope_key,availability_json FROM memory_items
        WHERE space=${space} AND scope_key IN (SELECT value FROM json_each(${keysJson}))
          AND status='active' AND index_state='ready' AND indexed_generation=generation
        ORDER BY rowid DESC LIMIT ${MEMORY_RECALL_SCAN_MAX_ITEMS}
      ) SELECT memory_id,scope_key,
        CASE WHEN json_extract(availability_json,'$.exposure')='visible' THEN
          (SELECT bm25(memory_items_fts) FROM memory_items_fts
            WHERE rowid=window.rowid AND memory_items_fts MATCH ${match})
        END AS rank
      FROM window`,
    );
    const ranked = rows
      .filter((row): row is typeof row & { rank: number } => row.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.memory_id.localeCompare(b.memory_id));
    return {
      scanned: rows.length,
      candidates: yield* Effect.forEach(ranked, (row) =>
        stored("recall-memory-id", decodeMemoryId(row.memory_id)).pipe(
          Effect.map((memoryId) => ({ memoryId, scopeKey: row.scope_key, rank: row.rank })),
        ),
      ),
    };
  });
  return { relatedThreads, recallCoverage, recallCandidates };
};
export type RecallStore = ReturnType<typeof makeRecallStore>;

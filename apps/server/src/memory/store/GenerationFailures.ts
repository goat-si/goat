import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";

const isFailureCode = Schema.is(M.MemoryFailureCode);

export const makeGenerationFailures = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  /**
   * Threads whose summary work failed for good, from work rows (report diagnostics are trimmed and
   * can be refused). Deleted threads and newer work of the thread drop a failure by
   * pruneSettledSummaryWork's rules, so status reads the same before and after pruning.
   */
  const readGenerationFailure = Effect.fn("MemoryStore.readGenerationFailure")(function* (input: {
    readonly environmentId: M.EnvironmentId;
    readonly memorySpaceId: M.MemorySpaceId | null;
  }) {
    const space = input.memorySpaceId ?? `_local:${input.environmentId}`;
    const rows = yield* stored(
      "generation-failure-read",
      sql<{
        threads: number;
        codes: number;
        failure_code: string | null;
      }>`SELECT count(DISTINCT json_extract(o.metadata_json,'$.sourceThread.environmentId')||' '||json_extract(o.metadata_json,'$.sourceThread.threadId')) AS threads,
        count(DISTINCT o.failure_code) AS codes,min(o.failure_code) AS failure_code
      FROM memory_outbox o
      WHERE o.space=${space} AND o.kind IN ('summary','consolidate') AND o.status='failed' AND o.failure_code IS NOT NULL
        AND json_extract(o.metadata_json,'$.kind')='summary'
        AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=json_extract(o.metadata_json,'$.sourceThread.threadId') AND t.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox n WHERE n.kind IN ('summary','consolidate')
          AND json_extract(n.metadata_json,'$.sourceThread.threadId')=json_extract(o.metadata_json,'$.sourceThread.threadId')
          AND coalesce(json_extract(n.metadata_json,'$.observedThroughSequence'),json_extract(n.metadata_json,'$.sourceWatermark.throughSequence'))
            >coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),json_extract(o.metadata_json,'$.sourceWatermark.throughSequence'))
          AND json_extract(n.metadata_json,'$.sourceThread.environmentId')=json_extract(o.metadata_json,'$.sourceThread.environmentId'))`,
    );
    const row = rows[0];
    if (!row || row.threads < 1) return undefined;
    return {
      threads: row.threads,
      // One reason is shown only when it explains every failed thread.
      failureCode: row.codes === 1 && isFailureCode(row.failure_code) ? row.failure_code : null,
    } satisfies M.MemorySyncStatus["generationFailure"];
  });
  return { readGenerationFailure };
};

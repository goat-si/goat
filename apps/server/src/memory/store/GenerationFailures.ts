import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";

const isFailureCode = Schema.is(M.MemoryFailureCode);

export const makeGenerationFailures = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  /**
   * Failed summary work, read from the work rows themselves: their report diagnostics are trimmed
   * per space and can be refused admission. A later completed run of the same conversation and
   * kind replaces the failure. Uses the same space as readLocalProcessingStatus.
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
        retrying: number | null;
        failure_code: string | null;
      }>`WITH failed AS (
        SELECT json_extract(o.metadata_json,'$.sourceThread.threadId') AS thread,o.status,o.failure_code,
          coalesce(o.terminal_at,o.next_attempt_at) AS at
        FROM memory_outbox o
        WHERE o.space=${space} AND o.kind IN ('summary','consolidate') AND o.status IN ('retry','running','failed')
          AND o.failure_code IS NOT NULL AND json_extract(o.metadata_json,'$.kind')='summary'
          AND NOT EXISTS (SELECT 1 FROM memory_outbox n WHERE n.kind IN ('summary','consolidate') AND n.kind=o.kind AND n.status='completed'
            AND json_extract(n.metadata_json,'$.sourceThread.threadId')=json_extract(o.metadata_json,'$.sourceThread.threadId')
            AND coalesce(json_extract(n.metadata_json,'$.observedThroughSequence'),json_extract(n.metadata_json,'$.sourceWatermark.throughSequence'))
              >=coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),json_extract(o.metadata_json,'$.sourceWatermark.throughSequence')))
      )
      SELECT count(DISTINCT thread) AS threads,max(status!='failed') AS retrying,
        (SELECT failure_code FROM failed ORDER BY at DESC LIMIT 1) AS failure_code
      FROM failed`,
    );
    const row = rows[0];
    if (!row || row.threads < 1 || !isFailureCode(row.failure_code)) return undefined;
    return {
      threads: row.threads,
      failureCode: row.failure_code,
      retrying: row.retrying === 1,
    } satisfies M.MemorySyncStatus["generationFailure"];
  });
  return { readGenerationFailure };
};

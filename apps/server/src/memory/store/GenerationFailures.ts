import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";

const isFailureCode = Schema.is(M.MemoryFailureCode);

export const makeGenerationFailures = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  /**
   * Threads with summary work that failed for good, read from the work rows: their report
   * diagnostics are trimmed per space and can be refused admission. Work still due again is not a
   * failure yet, and retention removes a failed row once newer work of its thread exists. Uses the
   * same space as readLocalProcessingStatus.
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
      }>`SELECT count(DISTINCT json_extract(metadata_json,'$.sourceThread.environmentId')||' '||json_extract(metadata_json,'$.sourceThread.threadId')) AS threads,
        count(DISTINCT failure_code) AS codes,min(failure_code) AS failure_code
      FROM memory_outbox
      WHERE space=${space} AND kind IN ('summary','consolidate') AND status='failed' AND failure_code IS NOT NULL
        AND json_extract(metadata_json,'$.kind')='summary'`,
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

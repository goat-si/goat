import { validateSummaryDependencies } from "../MemoryDependencies.ts";
import { promotionPrerequisiteReady } from "./FloorWrites.ts";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SyncWorkOwner } from "./StoreModel.ts";
import { stored } from "./StoreCodecs.ts";

export const suggestionForgetGeneration = Effect.fn("MemorySuggestions.forgetGeneration")(
  function* (space: M.MemorySpaceId) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* stored(
      "suggestion-generation",
      sql<{
        forget_generation: number;
      }>`SELECT forget_generation FROM memory_space_counters WHERE space=${space}`,
    );
    return row?.forget_generation ?? 0;
  },
);

export const acceptanceGenerationMatches = (sql: SqlClient.SqlClient) =>
  sql`(json_extract(memory_outbox.metadata_json,'$.acceptanceGeneration') IS NULL OR
    json_extract(memory_outbox.metadata_json,'$.acceptanceGeneration') =
      coalesce((SELECT forget_generation FROM memory_space_counters c
        WHERE c.space=memory_outbox.space),0))`;

export const checkAcceptanceDispatch = Effect.fn("MemorySuggestions.checkDispatch")(function* (
  sql: SqlClient.SqlClient,
  owner: SyncWorkOwner,
  input: M.MemoryHubPushInput,
  promotion: boolean,
) {
  const operation = input.operations[0];
  if (operation?.kind !== "upsert" || (!promotion && operation.forgetFence === undefined))
    return input;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* stored(
    "suggestion-dispatch",
    sql`SELECT 1 FROM memory_outbox WHERE id=${owner.workId} AND status='running'
      AND claimed_by=${owner.owner} AND sync_version=${owner.version}
      AND operation_digest=${owner.operationDigest} AND claimed_until=${owner.ownedUntil}
      AND claimed_until>${now} AND ${acceptanceGenerationMatches(sql)}
      AND ${promotionPrerequisiteReady(sql, "memory_outbox")}`,
  ).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })));
  if (!rows.length) return yield* new M.MemoryHubError({ code: "source_invalidated" });
  if (promotion)
    yield* validateSummaryDependencies(operation.memorySpaceId, operation.payload).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(
        (error) =>
          new M.MemoryHubError({
            code: error._tag === "MemoryStorageError" ? "storage_failed" : "source_invalidated",
          }),
      ),
    );
  return input;
});

export const purgeSpaceSuggestions = Effect.fn("MemorySuggestions.purgeOnForget")(function* (
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
) {
  yield* stored(
    "suggestion-forget-fence",
    sql`INSERT INTO memory_space_counters (space, forget_generation) VALUES (${space}, 1)
      ON CONFLICT(space) DO UPDATE SET forget_generation=forget_generation+1`,
  );
  const affected = sql`space=${space} AND kind='sync' AND status IN ('pending','retry','running')
    AND (json_extract(metadata_json,'$.acceptanceGeneration') IS NOT NULL OR id IN (
      SELECT 'sync:' || space || ':' || accept_operation_id FROM memory_save_suggestions
      WHERE space=${space} AND state='accepting'))`;
  yield* stored(
    "suggestion-forget-body",
    sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref IN (
      SELECT payload_ref FROM memory_outbox WHERE ${affected})
      AND NOT EXISTS (SELECT 1 FROM memory_revisions r
        WHERE r.space=memory_payloads.space AND r.payload_ref=memory_payloads.payload_ref)`,
  );
  yield* stored(
    "suggestion-forget-work",
    sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL,claimed_by=NULL,
      claimed_until=NULL,sync_version=sync_version+1 WHERE ${affected}`,
  );
  yield* stored(
    "suggestion-forget-purge",
    sql`DELETE FROM memory_save_suggestions WHERE space=${space}`,
  );
});

export const expireMemorySuggestions = Effect.fn("MemorySuggestions.expire")(function* (
  sql: SqlClient.SqlClient,
) {
  const now = yield* Clock.currentTimeMillis;
  yield* stored(
    "suggestions-expire",
    sql`DELETE FROM memory_save_suggestions WHERE expires_at<=${now}`,
  );
});

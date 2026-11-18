import { validateSummaryDependencies } from "../MemoryDependencies.ts";
import {
  floorWriteId,
  promotionBindingCurrent,
  promotionPrerequisiteReady,
} from "./FloorWrites.ts";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { MemoryWork, SyncWorkOwner } from "./StoreModel.ts";
import { stored } from "./StoreCodecs.ts";
import { moveScopesCurrent } from "./ScopeMoves.ts";

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

export const acceptingSuggestionOperation = Effect.fn("MemorySuggestions.acceptingOperation")(
  function* (
    sql: SqlClient.SqlClient,
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    origin: M.ScopedThreadRef,
  ) {
    const [row] = yield* stored(
      "suggestion-accepting-operation",
      sql<{ accept_operation_id: M.MemoryOperationId }>`SELECT accept_operation_id
      FROM memory_save_suggestions WHERE space=${space} AND id=${memoryId} AND state='accepting'
        AND origin_environment_id=${origin.environmentId} AND origin_thread_id=${origin.threadId}`,
    );
    if (row) return row.accept_operation_id;

    // A remote ACK settles the suggestion before the ordered tail installs its identity.
    const [completed] = yield* stored(
      "suggestion-acknowledged-operation",
      sql<{
        operation_id: M.MemoryOperationId;
      }>`SELECT json_extract(completed_receipt_json,'$.operationId') AS operation_id
      FROM memory_outbox o WHERE o.space=${space} AND o.memory_id=${memoryId}
        AND o.kind='sync' AND o.status='completed'
        AND json_extract(o.metadata_json,'$.kind')='upsert'
        AND json_extract(o.metadata_json,'$.authorityFirst') IS NOT NULL
        AND json_extract(o.metadata_json,'$.acceptanceGeneration') IS NOT NULL
        AND json_extract(o.metadata_json,'$.originEnvironmentId')=${origin.environmentId}
        AND json_extract(o.metadata_json,'$.revision.provenance.originThreadId')=${origin.threadId}
        AND json_extract(o.completed_receipt_json,'$.outcome')='accepted'
        AND json_extract(o.completed_receipt_json,'$.hubSequence')>0
        AND NOT EXISTS (SELECT 1 FROM memory_identity_ledger i WHERE i.space=o.space AND i.memory_id=o.memory_id)
        AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=o.space AND t.memory_id=o.memory_id)
        AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.memory_id=o.memory_id)
      LIMIT 1`,
    );
    return completed?.operation_id;
  },
);

export const bindPendingSuggestion = Effect.fn("MemorySuggestions.bindPending")(function* (
  sql: SqlClient.SqlClient,
  { memorySpaceId: space, memoryId, operationId }: M.MemoryOperation,
  origin: M.ScopedThreadRef,
) {
  const now = yield* Clock.currentTimeMillis;
  const [bound] = yield* stored(
    "suggestion-bind-remember",
    sql<{ forget_generation: number }>`UPDATE memory_save_suggestions
      SET state='accepting',accept_operation_id=${operationId}
      WHERE space=${space} AND id=${memoryId} AND state='pending' AND expires_at>${now}
        AND origin_environment_id=${origin.environmentId} AND origin_thread_id=${origin.threadId}
      RETURNING forget_generation`,
  );
  if (bound)
    yield* stored(
      "suggestion-bind-generation",
      sql`UPDATE memory_outbox SET metadata_json=json_set(metadata_json,'$.acceptanceGeneration',${bound.forget_generation})
        WHERE id=${floorWriteId(space, operationId)}`,
    );
});

export const acceptanceGenerationMatches = (sql: SqlClient.SqlClient) =>
  sql`(json_extract(memory_outbox.metadata_json,'$.acceptanceGeneration') IS NULL OR
    json_extract(memory_outbox.metadata_json,'$.acceptanceGeneration') =
      coalesce((SELECT forget_generation FROM memory_space_counters c
        WHERE c.space=memory_outbox.space),0))`;

export const checkSyncDispatch = Effect.fn("MemoryStore.checkSyncDispatch")(function* (
  sql: SqlClient.SqlClient,
  owner: SyncWorkOwner,
  input: M.MemoryHubPushInput,
  metadata: MemoryWork["metadata"],
) {
  const promotion = "summaryPrerequisite" in metadata;
  const boundSuggestion = "acceptanceGeneration" in metadata;
  const operation = input.operations[0];
  if (
    operation?.kind !== "move" &&
    (operation?.kind !== "upsert" ||
      (!promotion && !boundSuggestion && operation.forgetFence === undefined))
  )
    return input;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* stored(
    "suggestion-dispatch",
    sql`SELECT 1 FROM memory_outbox WHERE id=${owner.workId} AND status='running'
      AND claimed_by=${owner.owner} AND sync_version=${owner.version}
      AND operation_digest=${owner.operationDigest} AND claimed_until=${owner.ownedUntil}
      AND claimed_until>${now} AND ${acceptanceGenerationMatches(sql)}
      AND ${promotionPrerequisiteReady(sql, "memory_outbox")} AND ${promotionBindingCurrent(sql)}`,
  ).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })));
  if (!rows.length) return yield* new M.MemoryHubError({ code: "source_invalidated" });
  if (operation.kind === "move") {
    const binding = "moveBinding" in metadata ? metadata.moveBinding : undefined;
    const current = yield* moveScopesCurrent(sql, operation, binding).pipe(
      Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
    );
    if (!current) return yield* new M.MemoryHubError({ code: "source_invalidated" });
  }
  if (promotion && operation.kind === "upsert")
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

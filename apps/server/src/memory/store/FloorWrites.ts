import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Statement from "effect/sql/Statement";
import type * as SqlClient from "effect/sql/SqlClient";
import { memoryOperationDigest } from "../MemoryDecider.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { headsCodec, metadataOf, payloadCodec, stored, workMetadataCodec } from "./StoreCodecs.ts";
import {
  type InTx,
  MemoryCapacityError,
  type MemoryStorageError,
  Transaction,
} from "./StoreModel.ts";

export const floorWriteId = (space: M.MemorySpaceId, operationId: M.MemoryOperationId) =>
  `sync:${space}:${operationId}`;

export type PromotionPrerequisite = {
  readonly summaryPrerequisite: M.MemoryRevisionId;
  readonly promotionBinding?: {
    readonly project: M.ScopedProjectRef;
    readonly version: number;
  };
};

export interface FloorWriteStore {
  readonly stageFloorWrite: (
    operation: Extract<M.MemoryOperation, { kind: "upsert" }>,
    promotion?: PromotionPrerequisite,
  ) => InTx<void, MemoryCapacityError | MemoryStorageError>;
}

export const makeFloorWrites = (
  { sql }: Pick<StoreKernel, "sql">,
  { enqueueWork }: Pick<ItemWrites, "enqueueWork">,
) => {
  const stageFloorWrite: FloorWriteStore["stageFloorWrite"] = Effect.fn(
    "MemoryStore.stageFloorWrite",
  )(function* (operation, promotion) {
    yield* Transaction;
    const { memorySpaceId: space, memoryId, revision, operationId } = operation;
    const body = yield* payloadCodec.encode(operation.payload);
    const metadata = {
      ...metadataOf(operation),
      authorityFirst: memoryOperationDigest(operation),
      ...promotion,
    };
    const [usage] = yield* stored(
      "floor-stage-budget",
      sql<{ bytes: number }>`
      SELECT coalesce(sum(length(CAST(p.body_json AS BLOB)) + length(CAST(o.metadata_json AS BLOB))),0) AS bytes
      FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref
      WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    const current =
      (usage?.bytes ?? 0) +
      new TextEncoder().encode(body + (yield* workMetadataCodec.encode(metadata))).length;
    if (current > M.MEMORY_WORK_MAX_PAYLOAD_BYTES)
      return yield* new MemoryCapacityError({
        dimension: "work_bytes",
        limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
        current,
      });
    if (revision.payloadRef === revision.revisionId)
      yield* stored(
        "floor-stage-body",
        sql`
      INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json)
      VALUES (${space},${revision.payloadRef},${memoryId},${body},${yield* headsCodec.encode(operation.payload.derivedFromMemoryRevisions)})`,
      );
    yield* enqueueWork({
      id: floorWriteId(space, operationId),
      space,
      memoryId,
      kind: "sync",
      status: "pending",
      metadata,
      payloadRef: revision.payloadRef,
      attempt: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: null,
    });
  });
  return { stageFloorWrite };
};

export const promotionPrerequisiteReady = (
  sql: SqlClient.SqlClient,
  alias: "o" | "memory_outbox",
) => {
  const outbox = sql(alias);
  const prerequisite = sql`json_extract(${outbox}.metadata_json,'$.summaryPrerequisite')`;
  return sql`(${prerequisite} IS NULL OR EXISTS (
    SELECT 1 FROM memory_revisions r JOIN memory_items i ON i.space=r.space AND i.memory_id=r.memory_id
    WHERE r.space=${outbox}.space AND r.revision_id=${prerequisite}
    AND i.status='active' AND json_extract(i.availability_json,'$.exposure')='visible'
    AND NOT EXISTS (SELECT 1 FROM memory_revision_marks m WHERE m.space=r.space AND m.revision_id=r.revision_id)
    AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=r.space AND f.memory_id=r.memory_id)
    AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending p WHERE p.space=r.space AND p.operation_id=r.operation_id AND p.record_kind='operation')
  ))`;
};

export const promotionBindingCurrent = (sql: SqlClient.SqlClient) => sql`(
  json_extract(memory_outbox.metadata_json,'$.summaryPrerequisite') IS NULL OR
  json_extract(memory_outbox.metadata_json,'$.revision.scope.kind') != 'project' OR EXISTS (
    SELECT 1 FROM memory_project_bindings b
    WHERE b.memory_space_id=memory_outbox.space
      AND b.environment_id=json_extract(memory_outbox.metadata_json,'$.promotionBinding.project.environmentId')
      AND b.project_id=json_extract(memory_outbox.metadata_json,'$.promotionBinding.project.projectId')
      AND b.version=json_extract(memory_outbox.metadata_json,'$.promotionBinding.version')
      AND b.project_key_json IS NOT NULL
  ))`;

const discardQueuedPromotions = Effect.fn("MemoryStore.discardQueuedPromotions")(function* (
  sql: SqlClient.SqlClient,
  space: string,
  predicate: Statement.Fragment,
) {
  yield* Transaction;
  const latent = sql`space=${space} AND kind='sync' AND status IN ('pending','retry','running') AND ${predicate}`;
  yield* stored(
    "promotion-discard-body",
    sql`DELETE FROM memory_payloads
    WHERE space=${space} AND payload_ref IN (SELECT payload_ref FROM memory_outbox WHERE ${latent})
    AND NOT EXISTS (SELECT 1 FROM memory_revisions r
      WHERE r.space=memory_payloads.space AND r.payload_ref=memory_payloads.payload_ref)`,
  );
  yield* stored(
    "promotion-discard-work",
    sql`UPDATE memory_outbox
    SET status='cancelled',payload_ref=NULL,claimed_by=NULL,claimed_until=NULL,sync_version=sync_version+1
    WHERE ${latent}`,
  );
});

export const discardFloorPromotions = (
  sql: SqlClient.SqlClient,
  space: string,
  revision: M.MemoryRevisionId,
) =>
  discardQueuedPromotions(
    sql,
    space,
    sql`json_extract(metadata_json,'$.summaryPrerequisite')=${revision}`,
  );

export const discardRevokedProjectPromotions = (
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
  match: Statement.Fragment,
) => discardQueuedPromotions(sql, space, sql`${match} AND NOT ${promotionBindingCurrent(sql)}`);

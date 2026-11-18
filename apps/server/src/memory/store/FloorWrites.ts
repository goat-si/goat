import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
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

export interface FloorWriteStore {
  readonly stageFloorWrite: (
    operation: Extract<M.MemoryOperation, { kind: "upsert" | "move" }>,
  ) => InTx<void, MemoryCapacityError | MemoryStorageError>;
}

export const makeFloorWrites = (
  { sql }: Pick<StoreKernel, "sql">,
  { enqueueWork }: Pick<ItemWrites, "enqueueWork">,
) => {
  const stageFloorWrite: FloorWriteStore["stageFloorWrite"] = Effect.fn(
    "MemoryStore.stageFloorWrite",
  )(function* (operation: Extract<M.MemoryOperation, { kind: "upsert" | "move" }>) {
    yield* Transaction;
    const { memorySpaceId: space, memoryId, operationId } = operation;
    const body = operation.kind === "upsert" ? yield* payloadCodec.encode(operation.payload) : "";
    const metadata = { ...metadataOf(operation), authorityFirst: memoryOperationDigest(operation) };
    const [usage] = yield* stored(
      "floor-stage-budget",
      sql<{ bytes: number; items: number }>`
      SELECT count(*) AS items, coalesce(sum(coalesce(length(CAST(p.body_json AS BLOB)),0) + length(CAST(o.metadata_json AS BLOB))),0) AS bytes
      FROM memory_outbox o LEFT JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref
      WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    if ((usage?.items ?? 0) >= M.MEMORY_WORK_MAX_PENDING_ITEMS)
      return yield* new MemoryCapacityError({
        dimension: "work_items",
        limit: M.MEMORY_WORK_MAX_PENDING_ITEMS,
        current: usage?.items ?? 0,
      });
    const current =
      (usage?.bytes ?? 0) +
      new TextEncoder().encode(body + (yield* workMetadataCodec.encode(metadata))).length;
    if (current > M.MEMORY_WORK_MAX_PAYLOAD_BYTES)
      return yield* new MemoryCapacityError({
        dimension: "work_bytes",
        limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
        current,
      });
    if (
      operation.kind === "upsert" &&
      operation.revision.payloadRef === operation.revision.revisionId
    )
      yield* stored(
        "floor-stage-body",
        sql`
      INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json)
      VALUES (${space},${operation.revision.payloadRef},${memoryId},${body},${yield* headsCodec.encode(operation.payload.derivedFromMemoryRevisions)})`,
      );
    yield* enqueueWork({
      id: floorWriteId(space, operationId),
      space,
      memoryId,
      kind: "sync",
      status: "pending",
      metadata,
      payloadRef: operation.kind === "upsert" ? operation.revision.payloadRef : null,
      attempt: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: null,
    });
  });
  return { stageFloorWrite };
};

import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ItemWrites } from "./ItemWrites.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { headsCodec, metadataOf, payloadCodec, stored } from "./StoreCodecs.ts";
import { MemoryCapacityError, Transaction } from "./StoreModel.ts";

export const floorWriteId = (space: M.MemorySpaceId, operationId: M.MemoryOperationId) =>
  `sync:${space}:${operationId}`;

export const makeFloorWrites = (
  { sql }: Pick<StoreKernel, "sql">,
  { enqueueWork }: Pick<ItemWrites, "enqueueWork">,
) => {
  const stageFloorWrite = Effect.fn("MemoryStore.stageFloorWrite")(function* (
    operation: Extract<M.MemoryOperation, { kind: "upsert" }>,
  ) {
    yield* Transaction;
    const { memorySpaceId: space, memoryId, revision, operationId } = operation;
    const body = yield* payloadCodec.encode(operation.payload);
    const metadata = { ...metadataOf(operation), authorityFirst: true as const };
    const [usage] = yield* stored(
      "floor-stage-budget",
      sql<{ bytes: number }>`
      SELECT coalesce(sum(length(CAST(p.body_json AS BLOB)) + length(CAST(o.metadata_json AS BLOB))),0) AS bytes
      FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref
      WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    const current =
      (usage?.bytes ?? 0) + new TextEncoder().encode(body + JSON.stringify(metadata)).length;
    if (current > M.MEMORY_WORK_MAX_PAYLOAD_BYTES)
      return yield* new MemoryCapacityError({
        dimension: "work_bytes",
        limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
        current,
      });
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

export type FloorWriteStore = ReturnType<typeof makeFloorWrites>;

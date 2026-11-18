import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { floorWriteId, type FloorWriteMetadata } from "./store/FloorWrites.ts";
import { findMoveBinding, moveScopesCurrent } from "./store/ScopeMoves.ts";
import { hubReceiptCodec, stored } from "./store/StoreCodecs.ts";

type Permit = Effect.Effect<void, MemoryAccessError>;
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);

export const makeMoveMemory = (deps: {
  store: Store.MemoryStore["Service"];
  sql: SqlClient.SqlClient;
  environmentId: M.EnvironmentId;
  apply: (
    operation: M.MemoryOperation,
    permit: Permit,
    metadata?: FloorWriteMetadata,
  ) => Effect.Effect<Store.StoredReceipt, MemoryServiceError>;
  requireSharing: (space: M.MemorySpaceId) => Effect.Effect<void, MemoryAccessError>;
  submitFloorWrite?: Effect.Effect<void, MemoryServiceError>;
}) => {
  const { store, sql } = deps;
  const stage = Effect.fn("MemoryService.stageMove")(function* (
    op: M.MemoryMoveOperation,
    permit: Permit,
  ) {
    yield* permit;
    yield* deps.requireSharing(op.memorySpaceId);
    const digest = memoryOperationDigest(op);
    const old = yield* store.receipt(op.memorySpaceId, op.operationId);
    if (old && old.operationDigest !== digest)
      return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
    const workId = floorWriteId(op.memorySpaceId, op.operationId);
    const pending = yield* store.readWork(workId);
    if (
      pending &&
      (!("authorityFirst" in pending.metadata) || pending.metadata.authorityFirst !== digest)
    )
      return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
    const [row] = pending
      ? yield* stored(
          "move-replay",
          sql<{ completed_receipt_json: string | null }>`
          SELECT completed_receipt_json FROM memory_outbox WHERE id=${workId}`,
        )
      : [];
    const terminal = row?.completed_receipt_json
      ? yield* hubReceiptCodec.decode(row.completed_receipt_json)
      : old?.receipt;
    if (terminal?.outcome === "rejected") {
      if (terminal.capacity) return yield* new Store.MemoryCapacityError(terminal.capacity);
      return yield* new Store.MemoryStoreConflict({
        code: terminal.failureCode ?? "invalid_output",
      });
    }
    if (pending?.status === "cancelled")
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
    if (!pending && !old) {
      const moveBinding =
        op.toScope.kind === "project" ? yield* findMoveBinding(sql, op, op.toScope) : undefined;
      if (!(yield* moveScopesCurrent(sql, op, moveBinding)))
        return yield* new Store.MemoryStoreConflict({ code: "not_found" });
      yield* deps.apply(op, permit, moveBinding ? { moveBinding } : undefined);
    }
    return {
      operationDigest: digest,
      receipt: {
        operationId: op.operationId,
        memoryId: op.memoryId,
        outcome: "accepted" as const,
        revisionId: null,
        pendingSync: !old,
      },
    };
  });
  return Effect.fn("MemoryService.move")(function* (input: M.MemoryMoveInput, permit: Permit) {
    const op = yield* decodeOperation(
      { ...input, kind: "move", protocolVersion: 1, originEnvironmentId: deps.environmentId },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })));
    if (op.kind !== "move") return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
    const request = store.transact(stage(op, permit));
    const result = yield* request;
    if (!result.receipt.pendingSync || !deps.submitFloorWrite) return result;
    yield* permit;
    yield* deps.submitFloorWrite;
    const settled = yield* request;
    if (settled.receipt.pendingSync)
      return yield* new Store.MemoryStoreConflict({ code: "hub_unavailable" });
    return settled;
  });
};

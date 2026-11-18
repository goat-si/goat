import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import type { MemoryAccessError, MemoryServiceError } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { floorWriteId } from "./store/FloorWrites.ts";
import { hubReceiptCodec, stored } from "./store/StoreCodecs.ts";

type Permit = Effect.Effect<void, MemoryAccessError>;
const encodeProject = Schema.encodeSync(Schema.fromJsonString(M.MemoryProjectKey));
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);

export const makeMoveMemory = (deps: {
  store: Store.MemoryStore["Service"];
  sql: SqlClient.SqlClient;
  environmentId: M.EnvironmentId;
  apply: (
    operation: M.MemoryOperation,
    admission: Store.MemoryAdmissionContext,
    permit: Permit,
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
      if (op.toScope.kind === "project") {
        const bound = yield* stored(
          "move-project-binding",
          sql`
          SELECT 1 FROM memory_project_bindings
          WHERE memory_space_id=${op.memorySpaceId} AND environment_id=${deps.environmentId}
            AND project_key_json=${encodeProject(op.toScope.projectKey)} LIMIT 1`,
        );
        if (!bound.length) return yield* new Store.MemoryStoreConflict({ code: "not_found" });
      }
      yield* deps.apply(op, Store.localIntent, permit);
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

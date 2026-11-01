import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { RevertResults } from "./RevertResults.ts";
import {
  decodeOperation,
  headsCodec,
  metadataCodec,
  metadataOf,
  payloadCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryCapacityError, MemoryStoreConflict, strict } from "./StoreModel.ts";

export const makeRevertIntents = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "loadAggregate">,
  revertResults: Pick<RevertResults, "recordRevertResultTx">,
  itemWrites: Pick<ItemWrites, "enqueueWork">,
) => {
  const { sql, transact } = kernel;
  const { loadAggregate } = coreReads;
  const { recordRevertResultTx } = revertResults;
  const { enqueueWork } = itemWrites;
  const stageRevertIntent = Effect.fn("MemoryStore.stageRevertIntent")(function* (input: {
    operation: Extract<M.MemoryOperation, { kind: "revert" }>;
    requestDigest: string;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const op = input.operation;
        const valid = yield* stored("revert-codec", decodeOperation(op, strict));
        if (valid.kind !== "revert")
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        const original = yield* stored(
          "revert-intent",
          sql<{
            request_digest: string;
            operation_id: string;
          }>`SELECT request_digest,operation_id FROM memory_revert_intents WHERE space=${op.memorySpaceId} AND resolution_id=${op.revertsResolutionId}`,
        );
        if (original[0]) {
          if (
            original[0].operation_id !== op.operationId ||
            original[0].request_digest !== input.requestDigest
          )
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        const current = yield* loadAggregate(
          op.memorySpaceId,
          op.memoryId,
          {},
          {
            resolutionId: op.revertsResolutionId,
          },
        );
        if (current.tombstone || current.pendingForget)
          return yield* new MemoryStoreConflict({ code: "forgotten" });
        const resolution = current.resolutions.find(
          (r) => r.resolutionId === op.revertsResolutionId,
        );
        if (
          !resolution ||
          !resolution.inputRevisionIds.includes(op.restoredRevisionId) ||
          current.heads.length !== 1 ||
          current.heads[0] !== resolution.resultRevisionId ||
          op.expectedHeads[0] !== resolution.resultRevisionId
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        const now = yield* Clock.currentTimeMillis;

        const body = yield* payloadCodec.encode(op.payload);
        const metadata = yield* metadataCodec.encode(metadataOf(op));
        const usage = yield* storeUsageForRevert(op.memorySpaceId);
        if (
          usage.items >= M.MEMORY_WORK_MAX_PENDING_ITEMS ||
          usage.bytes + new TextEncoder().encode(body + metadata).length >
            M.MEMORY_WORK_MAX_PAYLOAD_BYTES
        )
          return yield* new MemoryCapacityError({
            dimension: "work_bytes",
            limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
          });
        yield* stored(
          "revert-stage-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,revert_deadline) VALUES (${op.memorySpaceId},${op.revision.payloadRef},${op.memoryId},${body},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)},${Date.parse(resolution.revertDeadlineUtc)})`,
        );
        yield* stored(
          "revert-stage",
          sql`INSERT INTO memory_revert_intents (space,operation_id,memory_id,resolution_id,restored_revision_id,expected_heads_json,request_digest,submission_metadata_json,payload_ref,created_at) VALUES (${op.memorySpaceId},${op.operationId},${op.memoryId},${op.revertsResolutionId},${op.restoredRevisionId},${yield* headsCodec.encode(op.expectedHeads)},${input.requestDigest},${metadata},${op.revision.payloadRef},${now})`,
        );
        yield* recordRevertResultTx({
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          resolutionId: op.revertsResolutionId,
          operationId: op.operationId,
          slot: { status: "pending" },
        });
        yield* enqueueWork({
          id: `revert:${op.memorySpaceId}:${op.operationId}`,
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          kind: "revert_intent",
          status: "pending",
          metadata: metadataOf(op),
          payloadRef: op.revision.payloadRef,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
      }),
    );
  });
  const storeUsageForRevert = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "revert-work-budget",
      sql<{
        items: number;
        bytes: number;
      }>`SELECT count(*) AS items,coalesce(sum(length(CAST(o.metadata_json AS BLOB))+coalesce(length(CAST(p.body_json AS BLOB)),0)),0) AS bytes FROM memory_outbox o LEFT JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    return rows[0]!;
  });
  return {
    stageRevertIntent,
    storeUsageForRevert,
  };
};

export type RevertIntents = ReturnType<typeof makeRevertIntents>;

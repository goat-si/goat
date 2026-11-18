import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MemoryCapacityError } from "./store/StoreModel.ts";

const encodeTail = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubPullResult));

const measureMemoryTailBytes = Effect.fn("MemoryService.measureTailBytes")(function* (
  operation: Exclude<M.MemoryOperation, { kind: "forget" }>,
  approval?: M.MemoryResolutionApproval,
) {
  const sequence = Number.MAX_SAFE_INTEGER;
  const receipt = {
    operationId: operation.operationId,
    memoryId: operation.memoryId,
    operationDigest: "0".repeat(64),
    hubSequence: sequence,
    outcome: "accepted" as const,
    ...(operation.kind === "resolve"
      ? {
          resolutionApproval: approval ?? {
            resolutionId: operation.resolution.resolutionId,
            appliedAtUtc: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
            revertDeadlineUtc: M.MemoryUtcTimestamp.make("1970-01-31T00:00:00.000Z"),
          },
        }
      : {}),
  };
  const encoded = yield* encodeTail({
    highWatermark: sequence,
    throughSequence: sequence,
    hasMore: true,
    entries: [{ kind: "operation", hubSequence: sequence, receipt, operation }],
  });
  return new TextEncoder().encode(encoded).length;
});

export const requireMemoryTailFit = Effect.fn("MemoryService.requireTailFit")(
  function* (
    operation: Exclude<M.MemoryOperation, { kind: "forget" }>,
    approval?: M.MemoryResolutionApproval,
  ) {
    const current = yield* measureMemoryTailBytes(operation, approval);
    if (current > M.MEMORY_TAIL_ADMISSION_BYTES)
      return yield* new MemoryCapacityError({
        dimension: "payload_bytes",
        limit: M.MEMORY_TAIL_ADMISSION_BYTES,
        current,
      });
    return current;
  },
  Effect.catchTags({
    SchemaError: () =>
      Effect.fail(
        new MemoryCapacityError({
          dimension: "payload_bytes",
          limit: M.MEMORY_TAIL_ADMISSION_BYTES,
          current: 262145,
        }),
      ),
  }),
);

import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MemoryCapacityError } from "./store/StoreModel.ts";

const encodeTail = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubPullResult));

const measureMemoryTailBytes = Effect.fn("MemoryService.measureTailBytes")(function* (
  operation: Exclude<M.MemoryOperation, { kind: "forget" }>,
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
          resolutionApproval: {
            resolutionId: operation.resolution.resolutionId,
            appliedAtUtc: operation.resolution.appliedAtUtc,
            revertDeadlineUtc: operation.resolution.revertDeadlineUtc,
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
  function* (operation: Exclude<M.MemoryOperation, { kind: "forget" }>) {
    const current = yield* measureMemoryTailBytes(operation);
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

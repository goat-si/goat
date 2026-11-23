import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { EnvironmentId, MemoryId, MemoryRevisionId, MemorySpaceId } from "@goat/contracts";
import { packMemoryContext } from "@goat/provider-core/server/memoryContext";

export function wp4Snapshot() {
  const snapshot = packMemoryContext({
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <instruction> 'data'",
      },
    ],
  });
  if (snapshot === undefined)
    throw new Error("The Cursor memory fixture must produce a context snapshot.");
  return snapshot;
}

export const gatedCursorRun = (
  sendCalls: number,
  runId: string,
  release: import("effect/Deferred").Deferred<void>,
) => ({
  agentId: "native-cursor-error",
  runId,
  wait: (sendCalls === 1 ? Deferred.await(release) : Effect.void).pipe(
    Effect.as({
      id: runId,
      requestId: `native-request-${sendCalls}`,
      status: "finished" as const,
      model: { id: "composer-2.5" },
      durationMs: 1,
      ...(sendCalls === 1 ? { result: "Error: RetriableError: WritableIterable is closed" } : {}),
    }),
  ),
  cancel: Effect.void,
});

export function cursorReceiptCounter() {
  const counter = { delivered: 0, uncertain: 0 };
  return {
    get delivered() {
      return counter.delivered;
    },
    get uncertain() {
      return counter.uncertain;
    },
    hooks: {
      onMemoryDelivered: () =>
        Effect.sync(() => {
          counter.delivered++;
        }),
      onMemoryDeliveryUncertain: () =>
        Effect.sync(() => {
          counter.uncertain++;
        }),
    },
  };
}

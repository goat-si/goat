import { RunId, ThreadId, type MemoryContextSnapshot } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as MemorySnapshot from "../../memory/MemorySnapshot.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";

export const makeMemoryRefreshFactory = Effect.gen(function* () {
  const memorySnapshot = yield* Effect.serviceOption(MemorySnapshot.MemorySnapshot);
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  // Run workers keep this callback after startup. Capture only service references
  // and scalar ids, outside start's scope containing the projection and history.
  const makeRefreshMemoryContext = (threadId: ThreadId, runId: RunId) => () =>
    Effect.gen(function* () {
      if (Option.isNone(memorySnapshot) || !providerSessions.currentMemoryPolicy) return undefined;
      const currentPolicy = providerSessions.currentMemoryPolicy(threadId);
      const policy = yield* currentPolicy;
      if (policy.grant === "none") return undefined;
      if ((yield* projectionStore.getThreadShell(threadId))?.activeRunId !== runId)
        return undefined;
      const snapshot = yield* memorySnapshot.value.forThread(threadId, policy, currentPolicy);
      return (yield* projectionStore.getThreadShell(threadId))?.activeRunId === runId
        ? snapshot
        : undefined;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Memory refresh unavailable", {
              threadId,
              runId,
            }).pipe(Effect.as(undefined)),
      ),
    );

  return (threadId: ThreadId, runId: RunId) => ({
    refreshMemoryContext: makeRefreshMemoryContext(threadId, runId),
    canDeliverMemory: (snapshot: MemoryContextSnapshot) =>
      Option.isSome(memorySnapshot) && memorySnapshot.value.canDeliver
        ? memorySnapshot.value.canDeliver(snapshot)
        : Effect.succeed(false),
    onMemoryDeliveryUncertain: (snapshot: MemoryContextSnapshot) =>
      Option.isSome(memorySnapshot) && memorySnapshot.value.recordDeliveryUncertain
        ? memorySnapshot.value.recordDeliveryUncertain(threadId, runId, snapshot.memorySpaceId)
        : Effect.void,
    onMemoryDelivered: (snapshot: MemoryContextSnapshot) =>
      Option.isSome(memorySnapshot) && memorySnapshot.value.recordDelivery
        ? memorySnapshot.value.recordDelivery(
            threadId,
            runId,
            snapshot.memorySpaceId,
            snapshot.items.map(({ memoryId, revisionId }) => ({ memoryId, revisionId })),
          )
        : Effect.void,
  });
});

import type { ProviderInstanceId, ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { NO_MEMORY_GENERATION } from "@goat/shared/memoryGenerationCapabilities";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const markAwaitingFirstCheck = (snapshot: ServerProvider): ServerProvider => ({
  ...snapshot,
  awaitingFirstCheck: true,
});

export const applyProviderMemoryRevocation = (
  snapshot: ServerProvider,
  instance: ProviderInstance | undefined,
): ServerProvider =>
  instance?.driverKind === snapshot.driver &&
  instance.textGeneration.memoryRevocation?.isRevoked() &&
  (snapshot.memoryGeneration?.summary !== false || snapshot.memoryGeneration.conflict !== false)
    ? { ...snapshot, memoryGeneration: NO_MEMORY_GENERATION }
    : snapshot;

export const applyProviderMemoryRevocations = (
  snapshots: ReadonlyArray<ServerProvider>,
  instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>,
): ReadonlyArray<ServerProvider> => {
  let updated: Array<ServerProvider> | undefined;
  snapshots.forEach((snapshot, index) => {
    const current = applyProviderMemoryRevocation(snapshot, instances.get(snapshot.instanceId));
    if (current === snapshot) return;
    updated ??= snapshots.slice();
    updated[index] = current;
  });
  return updated ?? snapshots;
};

export const readProviderRoutingSnapshot = Effect.fn("Provider.readRoutingSnapshot")(function* (
  instance: ProviderInstance,
  emittedSnapshot?: ServerProvider,
) {
  const awaiting = yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
  const snapshot = emittedSnapshot ?? (yield* instance.snapshot.getSnapshot);
  return awaiting ? markAwaitingFirstCheck(snapshot) : snapshot;
});

export const readProviderGenerationSnapshot = Effect.fn("Provider.readGenerationSnapshot")(
  function* (instance: ProviderInstance, emittedSnapshot?: ServerProvider) {
    const snapshot = yield* readProviderRoutingSnapshot(instance, emittedSnapshot);
    const memoryGeneration = instance.textGeneration.memoryRevocation?.isRevoked()
      ? NO_MEMORY_GENERATION
      : yield* instance.textGeneration.memoryCapabilities;
    return { ...snapshot, memoryGeneration };
  },
);

export const streamProviderGenerationSnapshots = (instance: ProviderInstance) => {
  const { memoryRevocation } = instance.textGeneration;
  if (memoryRevocation !== undefined) {
    return Stream.merge(instance.snapshot.streamChanges, memoryRevocation.changes).pipe(
      Stream.mapEffect(() => readProviderGenerationSnapshot(instance)),
    );
  }
  return instance.snapshot.streamChanges.pipe(
    Stream.mapEffect((snapshot) => readProviderGenerationSnapshot(instance, snapshot)),
  );
};

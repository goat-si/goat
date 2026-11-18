import type { ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import type { MemoryGenerationCapabilities } from "@goat/shared/memoryGenerationCapabilities";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const markAwaitingFirstCheck = (snapshot: ServerProvider): ServerProvider => ({
  ...snapshot,
  awaitingFirstCheck: true,
});

const withGenerationState = (
  memoryGeneration: MemoryGenerationCapabilities,
  snapshot: ServerProvider,
  awaiting: boolean,
): ServerProvider => {
  const annotated = { ...snapshot, memoryGeneration };
  return awaiting ? markAwaitingFirstCheck(annotated) : annotated;
};

export const readProviderGenerationSnapshot = Effect.fn("Provider.readGenerationSnapshot")(
  function* (instance: ProviderInstance) {
    const awaiting = yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
    const snapshot = yield* instance.snapshot.getSnapshot;
    return withGenerationState(
      yield* instance.textGeneration.memoryCapabilities,
      snapshot,
      awaiting,
    );
  },
);

export const streamProviderGenerationSnapshots = (instance: ProviderInstance) =>
  instance.snapshot.streamChanges.pipe(
    Stream.mapEffect((snapshot) =>
      Effect.gen(function* () {
        const awaiting = yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
        return withGenerationState(
          yield* instance.textGeneration.memoryCapabilities,
          snapshot,
          awaiting,
        );
      }),
    ),
  );

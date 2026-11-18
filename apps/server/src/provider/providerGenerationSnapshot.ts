import type { ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const markAwaitingFirstCheck = (snapshot: ServerProvider): ServerProvider => ({
  ...snapshot,
  awaitingFirstCheck: true,
});

export const readProviderGenerationSnapshot = Effect.fn("Provider.readGenerationSnapshot")(
  function* (instance: ProviderInstance) {
    const awaiting = yield* instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false);
    const snapshot = yield* instance.snapshot.getSnapshot;
    return awaiting ? markAwaitingFirstCheck(snapshot) : snapshot;
  },
);

export const streamProviderGenerationSnapshots = (instance: ProviderInstance) =>
  instance.snapshot.streamChanges.pipe(
    Stream.mapEffect((snapshot) =>
      (instance.snapshot.isAwaitingFirstCheck ?? Effect.succeed(false)).pipe(
        Effect.map((awaiting) => (awaiting ? markAwaitingFirstCheck(snapshot) : snapshot)),
      ),
    ),
  );

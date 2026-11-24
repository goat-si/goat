import * as Effect from "effect/Effect";

export function makeServerCaptureLease<E>(
  start: (tabId: string, lease: symbol) => Effect.Effect<void, E>,
  stop: (tabId: string, lease: symbol) => Effect.Effect<void>,
) {
  const leases = new Map<string, { readonly tabId: string; readonly lease: symbol }>();
  return Effect.fn("PreviewManager.serverCaptureLease")(function* (
    painting: {
      readonly key: { readonly threadId: string; readonly tabId: string };
      readonly active: boolean;
    },
    tabId: string | undefined,
  ) {
    const key = `${painting.key.threadId}\u0000${painting.key.tabId}`;
    const held = leases.get(key);
    if (!painting.active && held) {
      leases.delete(key);
      yield* stop(held.tabId, held.lease);
    } else if (painting.active && !held && tabId) {
      const lease = Symbol("server-capture");
      yield* start(tabId, lease).pipe(
        Effect.tap(() => Effect.sync(() => leases.set(key, { tabId, lease }))),
        Effect.catch((error) =>
          Effect.logWarning("Failed to unthrottle a server tab for its capture.", { tabId, error }),
        ),
      );
    }
  });
}

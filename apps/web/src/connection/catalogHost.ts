import {
  ConnectionBlockedError,
  ConnectionOnboarding,
  EnvironmentRegistry,
  handleConnectionCatalogOperation,
} from "@goat/client-runtime/connection";
import { serveConnectionCatalog } from "@goat/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export const layer: Layer.Layer<
  never,
  never,
  EnvironmentRegistry.EnvironmentRegistry | ConnectionOnboarding.ConnectionOnboarding
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const bridge = window.desktopBridge;
    if (bridge === undefined) return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map(
        (entries) =>
          [...entries.values()].find((entry) => entry.target._tag === "PrimaryConnectionTarget")
            ?.target.environmentId,
      ),
      Stream.changes,
      Stream.switchMap((environmentId) =>
        environmentId === undefined
          ? Stream.empty
          : registry.followStream(
              environmentId,
              Stream.fromEffect(
                serveConnectionCatalog((operation) =>
                  handleConnectionCatalogOperation(operation, (alias) =>
                    Effect.tryPromise({
                      try: () => bridge.resolveSshHost(alias),
                      catch: (cause) =>
                        new ConnectionBlockedError({
                          reason: "configuration",
                          detail:
                            cause instanceof Error
                              ? cause.message
                              : "Could not resolve the SSH host.",
                        }),
                    }),
                  ),
                ),
              ),
            ),
      ),
      Stream.runDrain,
      Effect.catchCause((cause) => Effect.logDebug("Connection catalog host stopped.", { cause })),
      Effect.forkScoped,
    );
  }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { type ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, ProviderLatestVersions.layer, ModelManifest.layerTest))(
  "retired provider probes",
  (it) => {
    it.effect("ignores a probe from an instance that settings replaced mid-refresh", () =>
      Effect.gen(function* () {
        const scenario = Effect.fn(function* (
          probeFails: boolean,
          run: (
            registry: ProviderRegistry.ProviderRegistry["Service"],
          ) => Effect.Effect<ReadonlyArray<ServerProvider>>,
        ) {
          const driver = ProviderDriverKind.make("codex");
          const instanceId = ProviderInstanceId.make("codex");
          const provider = {
            instanceId,
            driver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: "2.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;
          const retiredProbe = {
            ...provider,
            status: "error",
            installed: false,
            version: "1.0.0",
            message: "Codex CLI is not installed.",
          } as const satisfies ServerProvider;
          const probeStarted = yield* Deferred.make<void>();
          const releaseProbe = yield* Deferred.make<void>();
          const makeInstance = (snapshot: ServerProvider, refresh: Effect.Effect<void>) =>
            ({
              instanceId,
              driverKind: driver,
              continuationIdentity: { driverKind: driver, continuationKey: "codex:instance:codex" },
              displayName: undefined,
              enabled: true,
              snapshot: {
                resolveMaintenance: () =>
                  Effect.succeed(
                    makeManualOnlyProviderMaintenanceCapabilities({
                      provider: driver,
                      packageName: null,
                    }),
                  ),
                getSnapshot: Effect.succeed(snapshot),
                refresh: Effect.as(refresh, snapshot),
                streamChanges: Stream.empty,
                applyUsageLimits: () => Effect.void,
              },
              orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            }) satisfies ProviderInstance;
          const retiredInstance = makeInstance(
            retiredProbe,
            Deferred.succeed(probeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProbe)),
              Effect.andThen(probeFails ? Effect.die(new Error("probe failed")) : Effect.void),
            ),
          );
          const rebuiltInstance = makeInstance(provider, Effect.void);
          const instances = yield* Ref.make<ReadonlyArray<ProviderInstance>>([retiredInstance]);
          const changes = yield* PubSub.sliding<void>(1);
          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (requestedId) =>
                Ref.get(instances).pipe(
                  Effect.map((current) =>
                    current.find((instance) => instance.instanceId === requestedId),
                  ),
                ),
              listInstances: Ref.get(instances),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: PubSub.subscribe(changes),
            },
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const runtimeServices = yield* Layer.build(
            ProviderRegistry.layer.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "goat-provider-registry-retired-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          return yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const rebuiltPublished = yield* Stream.toPull(
              registry.streamChanges.pipe(
                Stream.filter((providers) => providers[0]?.version === provider.version),
              ),
            );
            const refresh = yield* run(registry).pipe(Effect.forkChild);
            yield* Deferred.await(probeStarted);
            yield* Ref.set(instances, [rebuiltInstance]);
            yield* PubSub.publish(changes, undefined);
            yield* rebuiltPublished;
            yield* Deferred.succeed(releaseProbe, undefined);
            return {
              provider,
              result: yield* Fiber.join(refresh),
              providers: yield* registry.getProviders,
            };
          }).pipe(Effect.provide(runtimeServices));
        });
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");

        const manual = yield* scenario(false, (registry) => registry.refresh());
        expect(manual.result).toEqual([expect.objectContaining(manual.provider)]);
        expect(manual.providers).toEqual([expect.objectContaining(manual.provider)]);

        // Neither the retired probe's failure nor its cached row can stand in for the replacement.
        for (const probeFails of [true, false]) {
          const afterUpdate = yield* scenario(probeFails, (registry) =>
            registry.refreshAfterUpdate(driver, instanceId),
          );
          expect(afterUpdate.result).toEqual([]);
          expect(afterUpdate.providers).toEqual([expect.objectContaining(afterUpdate.provider)]);
        }
      }),
    );
  },
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.effect(
  "model catalog checks probe only for changed manifests and clear cached CLI versions",
  () =>
    Effect.gen(function* () {
      const manifest = yield* Ref.make(ModelManifest.BUNDLED_MODEL_MANIFEST);
      const probes = yield* Ref.make(0);
      const invalidations = yield* Ref.make(0);
      const holdProbe = yield* Ref.make(false);
      const probeStarted = yield* Deferred.make<void>();
      const releaseProbe = yield* Deferred.make<void>();
      const secondInvalidation = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("catalog-test");
      const driver = ProviderDriverKind.make("codex");
      const provider = {
        instanceId,
        driver,
        status: "ready",
        enabled: true,
        installed: true,
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        version: "1.0.0",
        models: [],
        slashCommands: [],
        skills: [],
      } as const satisfies ServerProvider;
      const instance = {
        instanceId,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: "catalog-test" },
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
          getSnapshot: Effect.succeed(provider),
          refresh: Effect.gen(function* () {
            yield* Ref.update(probes, (n) => n + 1);
            if (yield* Ref.get(holdProbe)) {
              yield* Deferred.succeed(probeStarted, undefined);
              yield* Deferred.await(releaseProbe);
            }
            return provider;
          }),
          streamChanges: Stream.empty,
          applyUsageLimits: () => Effect.void,
        },
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      } satisfies ProviderInstance;
      const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      });
      const manifestLayer = Layer.succeed(ModelManifest.ModelManifest, {
        current: Ref.get(manifest),
        refresh: Ref.get(manifest),
        forceRefresh: Ref.get(manifest),
        refreshOnDemand: Ref.get(manifest),
        refreshInBackground: Effect.void,
      });
      const versions = Layer.effect(
        ProviderLatestVersions.ProviderLatestVersions,
        ProviderLatestVersions.make([["cli", "1.0.0"]]).pipe(
          Effect.map((service) => ({
            ...service,
            invalidateAll: service.invalidateAll.pipe(
              Effect.tap(() =>
                Ref.updateAndGet(invalidations, (n) => n + 1).pipe(
                  Effect.flatMap((n) =>
                    n === 2 ? Deferred.succeed(secondInvalidation, undefined) : Effect.void,
                  ),
                ),
              ),
            ),
          })),
        ),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const latest = yield* ProviderLatestVersions.ProviderLatestVersions;
        const cached = (version: string) => latest.cached("cli", Effect.succeed(version));
        const before = yield* Ref.get(probes);
        yield* Effect.all([registry.refreshModelCatalog, registry.refreshModelCatalog], {
          concurrency: "unbounded",
        });
        assert.strictEqual(yield* Ref.get(probes), before);
        assert.strictEqual(yield* Ref.get(invalidations), 0);
        assert.strictEqual(yield* cached("2.0.0"), "1.0.0");
        yield* Ref.set(manifest, {
          ...ModelManifest.BUNDLED_MODEL_MANIFEST,
          updatedAt: "2999-01-01T00:00:00Z",
        });
        yield* Effect.all([registry.refreshModelCatalog, registry.refreshModelCatalog], {
          concurrency: "unbounded",
        });
        assert.strictEqual(yield* Ref.get(probes), before + 1);
        assert.strictEqual(yield* Ref.get(invalidations), 1);
        assert.strictEqual(yield* cached("2.0.0"), "2.0.0");
        yield* registry.refreshModelCatalog;
        assert.strictEqual(yield* Ref.get(probes), before + 1);
        assert.strictEqual(yield* cached("3.0.0"), "2.0.0");
        yield* Ref.set(holdProbe, true);
        const oldPass = yield* registry.refresh().pipe(Effect.forkChild);
        yield* Deferred.await(probeStarted);
        yield* Ref.set(manifest, {
          ...ModelManifest.BUNDLED_MODEL_MANIFEST,
          updatedAt: "3000-01-01T00:00:00Z",
        });
        const picker = yield* registry.refreshModelCatalog.pipe(Effect.forkChild);
        yield* Deferred.await(secondInvalidation);
        yield* Ref.set(holdProbe, false);
        yield* Deferred.succeed(releaseProbe, undefined);
        yield* Fiber.join(oldPass);
        yield* Fiber.join(picker);
        assert.strictEqual(yield* Ref.get(invalidations), 2);
        assert.strictEqual(yield* Ref.get(probes), before + 3);
      }).pipe(
        Effect.provide(
          ProviderRegistry.layer.pipe(
            Layer.provideMerge(instances),
            Layer.provideMerge(manifestLayer),
            Layer.provideMerge(versions),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "model-catalog-refresh-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import { fromRunner } from "@goat/provider-core/server/textGenerationOperations";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as MemoryGenerationHold from "../memory/MemoryGenerationHold.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const HoldHealthPublication = Context.Reference("test/HoldHealthPublication", {
  defaultValue: () => false,
});

it("drops Cursor models a completed catalog read no longer returns", () => {
  const previousProvider = {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    version: "1.0.0",
    models: [
      { slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null },
      { slug: "retired-model-x", name: "Retired", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;
  const refreshedProvider = {
    ...previousProvider,
    checkedAt: "2026-10-30T00:01:00.000Z",
    models: [previousProvider.models[0]],
  } satisfies ServerProvider;
  const failedProvider = {
    ...refreshedProvider,
    status: "error",
    auth: { status: "unknown" },
    message: "Cursor SDK model discovery timed out.",
  } satisfies ServerProvider;

  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, refreshedProvider).models,
    [previousProvider.models[0]],
  );
  assert.deepStrictEqual(
    ProviderRegistry.mergeProviderSnapshot(previousProvider, failedProvider).models,
    [...previousProvider.models],
  );
});

it.effect.each(["before commit", "during the cache write"] as const)(
  "routes memory away from Cursor and returns revoked capabilities when refresh pauses %s",
  (pause) =>
    Effect.gen(function* () {
      const cursor = ProviderInstanceId.make("cursor");
      const codex = ProviderInstanceId.make("codex");
      const cursorSelection = { instanceId: cursor, model: "auto" };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [cursor]: { driver: ProviderDriverKind.make("cursor"), enabled: true },
        },
        memoryModelSelection: cursorSelection,
        textGenerationModelSelection: cursorSelection,
      };
      const sandboxSupported = yield* Ref.make(true);
      const capabilityChanges = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 });
      const registered = yield* PubSub.sliding<void>(1);
      const healthRefreshed = yield* Ref.make(false);
      const healthPublishStarted = yield* Deferred.make<void>();
      const releaseHealthPublish = yield* Deferred.make<void>();
      const refreshedAt = "2026-10-30T00:01:00.000Z";
      const pauseRefresh = Deferred.succeed(healthPublishStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseHealthPublish)),
      );
      const makeInstance = (name: "cursor" | "codex", model: string) => {
        const instanceId = ProviderInstanceId.make(name);
        const driverKind = ProviderDriverKind.make(name);
        const snapshot = {
          instanceId,
          driver: driverKind,
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-10-30T00:00:00.000Z",
          version: null,
          models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshed = { ...snapshot, checkedAt: refreshedAt };
        const textGeneration = {
          ...fromRunner("fixture", () => Effect.die("Unexpected generation.")),
          memoryCapabilities: (name === "cursor"
            ? Ref.get(sandboxSupported)
            : Effect.succeed(true)
          ).pipe(Effect.map((supported) => ({ summary: supported, conflict: supported }))),
          ...(name === "cursor"
            ? {
                memoryRevocation: {
                  isRevoked: () => !Ref.getUnsafe(sandboxSupported),
                  changes: Stream.fromPubSub(capabilityChanges),
                },
              }
            : {}),
        };
        return {
          instanceId,
          driverKind,
          continuationIdentity: { driverKind, continuationKey: name },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: driverKind,
                  packageName: null,
                }),
              ),
            getSnapshot: Ref.get(healthRefreshed).pipe(
              Effect.map((changed) => (name === "cursor" && changed ? refreshed : snapshot)),
            ),
            refresh: Ref.set(healthRefreshed, true).pipe(Effect.as(refreshed)),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration,
        } satisfies ProviderInstance;
      };
      const instances = [makeInstance("cursor", "auto"), makeInstance("codex", "gpt-5")];
      const registryLayer = ProviderRegistry.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
              listUnavailable: Effect.succeed([]),
              subscribeChanges: PubSub.subscribe(registered),
            }),
            ProviderLatestVersions.layer,
            Layer.effect(
              ModelManifest.ModelManifest,
              Effect.gen(function* () {
                const manifest = yield* ModelManifest.ModelManifest;
                return {
                  ...manifest,
                  current: Effect.gen(function* () {
                    if (
                      pause === "before commit" &&
                      (yield* HoldHealthPublication) &&
                      (yield* Ref.get(healthRefreshed))
                    ) {
                      yield* pauseRefresh;
                    }
                    return yield* manifest.current;
                  }),
                };
              }),
            ).pipe(Layer.provide(ModelManifest.layerTest)),
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-cursor-memory-update-" }),
          ),
        ),
        Layer.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.effect(
              FileSystem.FileSystem,
              Effect.map(FileSystem.FileSystem, (fs) => ({
                ...fs,
                rename: (from, to) =>
                  Effect.gen(function* () {
                    if (pause === "during the cache write" && (yield* HoldHealthPublication)) {
                      yield* pauseRefresh;
                    }
                    return yield* fs.rename(from, to);
                  }),
              })),
            ).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const hold = yield* MemoryGenerationHold.make;
        assert.equal((yield* hold.resolveModel(settings))?.instanceId, cursor);
        assert.equal((yield* hold.resolveModel(settings, "conflict"))?.instanceId, cursor);

        const published = yield* Stream.toPull(registry.streamChanges);
        const healthRefresh = yield* registry
          .refreshInstance(cursor)
          .pipe(Effect.provideService(HoldHealthPublication, true), Effect.forkScoped);
        yield* Deferred.await(healthPublishStarted);
        if (pause === "during the cache write") {
          const committed = (yield* registry.getProviders).find(
            (provider) => provider.instanceId === cursor,
          );
          assert.equal(committed?.checkedAt, refreshedAt);
          assert.deepEqual(committed?.memoryGeneration, { summary: true, conflict: true });
        }
        yield* Ref.set(sandboxSupported, false);
        assert.equal((yield* hold.resolveModel(settings))?.instanceId, codex);
        assert.equal((yield* hold.resolveModel(settings, "conflict"))?.instanceId, codex);
        yield* PubSub.publish(capabilityChanges, undefined);
        const [providers] = yield* published;
        const revoked = { summary: false, conflict: false };
        assert.deepEqual(
          providers.find((provider) => provider.instanceId === cursor)?.memoryGeneration,
          revoked,
        );
        assert.equal((yield* hold.resolveModel(settings))?.instanceId, codex);
        assert.equal((yield* hold.resolveModel(settings, "conflict"))?.instanceId, codex);

        yield* Deferred.succeed(releaseHealthPublish, undefined);
        const refreshed = yield* Fiber.join(healthRefresh);
        assert.deepEqual(
          refreshed.find((provider) => provider.instanceId === cursor)?.memoryGeneration,
          revoked,
        );
        assert.equal((yield* hold.resolveModel(settings))?.instanceId, codex);
        assert.equal((yield* hold.resolveModel(settings, "conflict"))?.instanceId, codex);
      }).pipe(Effect.provide(registryLayer));
    }),
);

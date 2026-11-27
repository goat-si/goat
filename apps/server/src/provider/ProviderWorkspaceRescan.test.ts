import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { fromRunner } from "@goat/provider-core/server/textGenerationOperations";

it.effect("rescans an enrolled workspace after a provider startup notification", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const driver = ProviderDriverKind.make("claudeAgent");
    const provider = {
      instanceId,
      driver,
      status: "ready",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      version: "1.0.0",
      models: [],
      slashCommands: [],
      skills: [],
    } as const satisfies ServerProvider;
    const scans = yield* Ref.make(0);
    const rescans = yield* Queue.unbounded<string>();
    const instance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "claude:rescan" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
        getSnapshot: Effect.succeed(provider),
        refresh: Effect.succeed(provider),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      workspaceRescans: Stream.fromQueue(rescans),
      snapshotForCwd: () =>
        Ref.updateAndGet(scans, (n) => n + 1).pipe(
          Effect.map((count) => ({
            ...provider,
            skills: [
              { name: `skill-${count}`, path: `/workspace/skill-${count}/SKILL.md`, enabled: true },
            ],
          })),
        ),
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: fromRunner("fixture", () => Effect.die("unexpected")),
    } satisfies ProviderInstance;
    const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(instance),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    });
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.build(
      ProviderRegistry.layer.pipe(
        Layer.provideMerge(instances),
        Layer.provideMerge(ModelManifest.layerTest),
        Layer.provideMerge(ProviderLatestVersions.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-rescan-test-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ).pipe(Scope.provide(scope));
    const registry = yield* ProviderRegistry.ProviderRegistry.pipe(Effect.provide(services));
    yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
    assert.equal(yield* Ref.get(scans), 1);
    yield* Queue.offer(rescans, "/workspace");
    yield* Queue.offer(rescans, "/workspace");
    yield* Queue.offer(rescans, "/workspace");
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(scans), 2);
    const updated = (yield* registry.getProviders)[0];
    assert.isDefined(updated?.workspaceRescannedAt);
    assert.equal(
      updated?.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace")?.skills?.[0]?.name,
      "skill-2",
    );
    yield* Queue.offer(rescans, "/not-enrolled");
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(scans), 2);
  }),
);

it.effect("stamps a rescan that changed only the directory's models", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const driver = ProviderDriverKind.make("claudeAgent");
    const provider = {
      instanceId,
      driver,
      status: "ready",
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      version: "1.0.0",
      models: [],
      slashCommands: [],
      skills: [],
    } as const satisfies ServerProvider;
    const scans = yield* Ref.make(0);
    const rescans = yield* Queue.unbounded<string>();
    const instance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "claude:rescan-models" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
        getSnapshot: Effect.succeed(provider),
        refresh: Effect.succeed(provider),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      workspaceRescans: Stream.fromQueue(rescans),
      snapshotForCwd: () =>
        Ref.updateAndGet(scans, (n) => n + 1).pipe(
          Effect.map((count) => ({
            ...provider,
            ...(count > 1
              ? {
                  workspaceModels: [
                    { slug: "vendor/live", name: "Live", isCustom: false, capabilities: null },
                  ],
                }
              : {}),
          })),
        ),
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: fromRunner("fixture", () => Effect.die("unexpected")),
    } satisfies ProviderInstance;
    const instances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(instance),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    });
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.build(
      ProviderRegistry.layer.pipe(
        Layer.provideMerge(instances),
        Layer.provideMerge(ModelManifest.layerTest),
        Layer.provideMerge(ProviderLatestVersions.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-rescan-models-test-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ).pipe(Scope.provide(scope));
    const registry = yield* ProviderRegistry.ProviderRegistry.pipe(Effect.provide(services));
    yield* registry.refreshWorkspaceSnapshot({ instanceId, cwd: "/workspace" });
    yield* Queue.offer(rescans, "/workspace");
    yield* TestClock.adjust("1 second");
    const updated = (yield* registry.getProviders)[0];
    assert.isString(updated?.workspaceRescannedAt);
  }),
);

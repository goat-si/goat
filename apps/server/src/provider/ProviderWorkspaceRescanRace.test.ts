import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import { fromRunner } from "@goat/provider-core/server/textGenerationOperations";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const makeHarness = Effect.gen(function* () {
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
  const scans = yield* Queue.unbounded<{ cwd: string; result: Deferred.Deferred<string> }>();
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
    snapshotForCwd: (cwd: string) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<string>();
        yield* Queue.offer(scans, { cwd, result });
        const name = yield* Deferred.await(result);
        if (name === "FAIL") return yield* Effect.die("fixture scan failure");
        return {
          ...provider,
          skills: [{ name, path: `/workspace/${name}/SKILL.md`, enabled: true }],
        };
      }),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-rescan-race-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ).pipe(Scope.provide(scope));
  const registry = yield* ProviderRegistry.ProviderRegistry.pipe(Effect.provide(services));
  const seed = Effect.fnUntraced(function* (cwd: string) {
    const pending = yield* registry
      .refreshWorkspaceSnapshot({ instanceId, cwd })
      .pipe(Effect.forkChild);
    const scan = yield* Queue.take(scans);
    yield* Deferred.succeed(scan.result, "initial");
    yield* Fiber.join(pending);
  });
  return { registry, scans, rescans, instanceId, seed };
});

it.effect("keeps a failed rescan's prior inventory and reports provider error", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.seed("/workspace");
    const status = yield* h.registry.streamChanges.pipe(
      Stream.filter((providers) => providers[0]?.status === "error"),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Queue.offer(h.rescans, "/workspace");
    yield* TestClock.adjust("1 second");
    const scan = yield* Queue.take(h.scans);
    yield* Deferred.succeed(scan.result, "FAIL");
    yield* Fiber.join(status);
    const provider = (yield* h.registry.getProviders)[0];
    assert.equal(provider?.status, "error");
    assert.equal(provider?.workspaceSnapshots?.[0]?.skills?.[0]?.name, "initial");
  }),
);

it.effect.each(["FAIL", "stale"] as const)(
  "a newer refresh wins over an older rescan: %s",
  (oldResult) =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.seed("/workspace");
      yield* h.seed("/barrier");
      yield* Queue.offer(h.rescans, "/workspace");
      yield* TestClock.adjust("1 second");
      const stale = yield* Queue.take(h.scans);
      const fresh = yield* h.registry
        .refreshWorkspaceSnapshot({ instanceId: h.instanceId, cwd: "/workspace", fresh: true })
        .pipe(Effect.forkChild);
      const latest = yield* Queue.take(h.scans);
      yield* Deferred.succeed(latest.result, "newest");
      yield* Fiber.join(fresh);
      yield* Deferred.succeed(stale.result, oldResult);
      yield* Queue.offer(h.rescans, "/barrier");
      yield* TestClock.adjust("1 second");
      const barrier = yield* Queue.take(h.scans);
      yield* Deferred.succeed(barrier.result, "initial");
      const provider = (yield* h.registry.getProviders)[0];
      assert.notEqual(provider?.status, "error");
      assert.equal(
        provider?.workspaceSnapshots?.find((entry) => entry.cwd === "/workspace")?.skills?.[0]
          ?.name,
        "newest",
      );
    }),
);

it.effect("rescans after an earlier workspace scan was already in flight", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness;
    yield* h.seed("/barrier");
    const initial = yield* h.registry
      .refreshWorkspaceSnapshot({ instanceId: h.instanceId, cwd: "/workspace" })
      .pipe(Effect.forkChild);
    const oldScan = yield* Queue.take(h.scans);
    yield* Queue.offer(h.rescans, "/workspace");
    yield* TestClock.adjust("1 second");
    yield* Deferred.succeed(oldScan.result, "old");
    yield* Fiber.join(initial);
    const pending = yield* Queue.take(h.scans);
    yield* Deferred.succeed(pending.result, "new");
    yield* Queue.offer(h.rescans, "/barrier");
    yield* TestClock.adjust("1 second");
    const barrier = yield* Queue.take(h.scans);
    yield* Deferred.succeed(barrier.result, "initial");
    assert.equal(
      (yield* h.registry.getProviders)[0]?.workspaceSnapshots?.find(
        (entry) => entry.cwd === "/workspace",
      )?.skills?.[0]?.name,
      "new",
    );
  }),
);

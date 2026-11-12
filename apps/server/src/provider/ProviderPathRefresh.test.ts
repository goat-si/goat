import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { makeApplyDesktopShellEnvironmentSnapshot } from "../resourceTelemetry/DesktopShellEnvironmentReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostPathChanged } from "./hostPathChanged.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderPathRefresh from "./ProviderPathRefresh.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.effect(
  "refreshes providers once per PATH change and once more for a burst during a refresh",
  () =>
    Effect.gen(function* () {
      const changed = Latch.makeUnsafe(false);
      let refreshes = 0;
      const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        awaitInFlightRefresh: Effect.void,
        refresh: () =>
          Effect.sleep("1 second").pipe(
            Effect.andThen(Effect.sync(() => void refreshes++)),
            Effect.as([]),
          ),
      });
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 hour");
        expect(refreshes).toBe(0);

        yield* changed.open;
        yield* TestClock.adjust("500 millis");
        for (let burst = 0; burst < 5; burst++) yield* changed.open;
        yield* TestClock.adjust("1 hour");
        expect(refreshes).toBe(2);
      }).pipe(
        Effect.provide(ProviderPathRefresh.layer.pipe(Layer.provide(registry))),
        Effect.provideService(HostPathChanged, changed),
      );
    }),
);

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");

/** A provider whose refresh runs `check` and reads as installed when it returns true. */
const fakeInstance = (
  instanceId: ProviderInstanceId,
  check: Effect.Effect<boolean>,
): ProviderInstance => {
  const driver = ProviderDriverKind.make(instanceId);
  let installed = false;
  const getSnapshot = Effect.sync((): ServerProvider => ({
    instanceId,
    driver,
    status: installed ? "ready" : "error",
    enabled: true,
    installed,
    auth: { status: "unknown" },
    checkedAt: "2026-11-12T00:00:00.000Z",
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
  }));
  return {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: instanceId + ":instance" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getSnapshot,
      refresh: check.pipe(
        Effect.tap((found) => Effect.sync(() => void (installed = found))),
        Effect.andThen(getSnapshot),
      ),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
};

it.effect(
  "checks a provider again with the new PATH when the PATH changes during a provider refresh",
  () =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        PATH: "/old/bin",
        GOAT_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
      };
      const changed = Latch.makeUnsafe(false);
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(
        environment,
        "darwin",
        Effect.asVoid(changed.open),
      );
      const snapshot = (discovered: boolean) =>
        ({
          version: 1,
          type: "shellEnvironment",
          platform: "darwin",
          discovered,
          environment: { PATH: "/recovered/bin" },
        }) as const;
      const checks = { claude: 0, codex: 0 };
      const claudeChecked = yield* Deferred.make<void>();
      const codexChecking = yield* Deferred.make<void>();
      const releaseCodex = yield* Deferred.make<void>();
      const instances = [
        // Finishes at once: by the time PATH changes, this pass has already read it as missing.
        fakeInstance(
          CLAUDE,
          Effect.sync(() => {
            checks.claude++;
            return environment.PATH === "/recovered/bin";
          }).pipe(Effect.tap(() => Deferred.succeed(claudeChecked, undefined))),
        ),
        // Keeps the first pass in flight until the test lets it go.
        fakeInstance(
          CODEX,
          Effect.sync(() => void checks.codex++).pipe(
            Effect.andThen(Deferred.succeed(codexChecking, undefined)),
            Effect.andThen(Deferred.await(releaseCodex)),
            Effect.as(true),
          ),
        ),
      ];
      const registryLayer = ProviderRegistry.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
            getInstance: (requestedId) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === requestedId)),
            listInstances: Effect.succeed(instances),
            listUnavailable: Effect.succeed([]),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
          }),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-provider-path-refresh-" }),
        ),
        Layer.provide(ProviderLatestVersions.layer),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" })),
              ),
            ),
          ).pipe(Layer.provideMerge(ModelManifest.layerTest)),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const first = yield* registry.refresh().pipe(Effect.forkChild);
        yield* Deferred.await(claudeChecked);
        yield* Deferred.await(codexChecking);
        const followUp = yield* ProviderPathRefresh.refreshOnPathChange.pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* applySnapshot(snapshot(false));
        yield* applySnapshot(snapshot(true));
        yield* Deferred.succeed(releaseCodex, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(followUp);

        expect(checks).toEqual({ claude: 2, codex: 2 });
        const claude = (yield* registry.getProviders).find(
          (provider) => provider.instanceId === CLAUDE,
        );
        expect(claude?.installed).toBe(true);
        expect(changed.isOpen()).toBe(false);
      }).pipe(Effect.provide(registryLayer), Effect.provideService(HostPathChanged, changed));
    }).pipe(Effect.scoped),
);

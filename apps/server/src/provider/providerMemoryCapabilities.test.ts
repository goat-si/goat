import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as OpenCodeRuntime from "@goat/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@goat/provider-opencode/server/OpenCodeServerLedger";
import * as HostProcess from "@goat/shared/HostProcess";
import { supportsMemoryGeneration } from "@goat/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import { memoryFixture } from "../textGeneration/memoryGenerationFixture.testkit.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as Hydration from "./ProviderInstanceRegistryHydration.ts";
import { layerHydrationTestServices } from "./ProviderInstanceRegistryHydration.testkit.ts";
import { readProviderGenerationSnapshot } from "./providerGenerationSnapshot.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const cases = [
  { driver: "pi", config: {}, reason: "unsupported_operation" },
  { driver: "omo", config: {}, reason: "unsupported_operation" },
  { driver: "muse", config: {}, reason: "unsupported_operation" },
  { driver: "fx", config: {}, reason: "unsupported_operation" },
  { driver: "acpRegistry", config: { source: "local" }, reason: "unsupported_operation" },
  { driver: "devinCloud", config: {}, reason: "unsupported_operation" },
  { driver: "claudeCloud", config: {}, reason: "unsupported_operation" },
  { driver: "cursorCloud", config: {}, reason: "unsupported_operation" },
  { driver: "opencode", config: { serverUrl: "https://opencode.example" }, reason: "unavailable" },
  {
    instance: "opencode-home",
    driver: "opencode",
    config: { modelRoute: "opencodex", opencodexBaseUrl: "http://127.0.0.1:10100/v1" },
    reason: "unsupported_operation",
  },
] as const;

const providerInstances = Object.fromEntries(
  cases.map((row) => [
    "instance" in row ? row.instance : row.driver,
    { driver: ProviderDriverKind.make(row.driver), config: row.config, enabled: true },
  ]),
);

const home = "http://127.0.0.1:10100/v1";
const layerHome = Layer.mergeAll(
  Layer.mock(Inventory.OpenCodexInventory)({
    readParity: Effect.succeed({
      ...fleetSnapshot("mac-studio"),
      binaries: [{ path: "/fixture/ocx", version: "2.92.0" }],
    }),
  }),
  Layer.mock(Runner.ProcessRunner)({
    run: () =>
      Effect.succeed({
        stdout: JSON.stringify({
          provider: { opencodex: { options: { baseURL: home }, models: { model: {} } } },
          providers: { opencodex: { settings: { baseURL: home }, models: { model: {} } } },
        }),
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  }),
);

const layer = Hydration.layer.pipe(
  Layer.provide(Layer.merge(layerHydrationTestServices, layerHome)),
  Layer.provide(AntigravityInstallation.AntigravityInstallation.layer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest))),
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(ResetCreditCoordinator.layerTest),
  Layer.provide(
    Layer.mergeAll(
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-memory-capabilities-" }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "unused" }),
      Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({}),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("memory-capability-test")),
      }),
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected request to provider.")),
      ),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Unexpected provider launch.")),
      ),
      Layer.effect(
        HostProcess.HomeDirectory,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie);
        }),
      ),
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provide(
    Settings.layerTest({ providerInstances }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

it.layer(layer)("memory capabilities of registered provider wrappers", (it) => {
  it.effect.each(cases)("$driver with $config refuses both memory operations", (row) =>
    Effect.gen(function* () {
      const registry = yield* ProviderInstanceRegistry;
      const instanceId = ProviderInstanceId.make("instance" in row ? row.instance : row.driver);
      const instance = yield* registry.getInstance(instanceId);
      if (instance === undefined)
        return yield* Effect.die(
          (yield* registry.listUnavailable).find((row) => row.instanceId === instanceId) ??
            row.driver,
        );

      const { summary, conflict } = memoryFixture(instanceId);
      const published = yield* readProviderGenerationSnapshot(instance);
      const resolution = yield* Effect.flip(
        instance.textGeneration.resolveMemoryConflict(conflict),
      );
      const generation = yield* Effect.flip(instance.textGeneration.generateMemorySummary(summary));
      assert.deepEqual(published.memoryGeneration, { summary: false, conflict: false });
      const { memoryGeneration: _, ...legacy } = published;
      assert.equal(supportsMemoryGeneration({ providerInstances }, legacy, "conflict"), false);
      assert.equal(supportsMemoryGeneration({ providerInstances }, legacy, "summary"), false);
      assert.propertyVal(resolution.cause, "code", row.reason);
      assert.propertyVal(generation.cause, "code", row.reason);
      if ("instance" in row) assert.equal(published.homeRoute?.modelRoute, "opencodex");
    }),
  );
});

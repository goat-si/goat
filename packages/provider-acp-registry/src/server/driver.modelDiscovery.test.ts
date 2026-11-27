import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
};

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    refreshIndex: () => Effect.succeed(false),
    invalidateIndex: () => Effect.void,
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    prepareRuntimeSpawn: (resolved) => Effect.succeed(resolved.spawn),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

// Reports `effort` levels for its current model only and logs each model switch.
const perModelEffortAgentSource = `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [logPath, modelsPath] = process.argv.slice(2);
const levels = JSON.parse(readFileSync(modelsPath, "utf8"));
const modelIds = Object.keys(levels);
let current = modelIds[0];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: modelIds.map((value) => ({ value, name: value })),
  },
  ...(levels[current] === null
    ? []
    : [
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: levels[current][0],
          options: levels[current].map((value) => ({ value, name: value })),
        },
      ]),
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "probe-session", configOptions: configOptions() } });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
  } else if (method === "session/set_config_option" && params.configId === "model") {
    appendFileSync(logPath, params.value + "\\n");
    current = params.value;
    send({ id, result: { configOptions: configOptions() } });
  } else {
    send({ id, result: {} });
  }
});
`;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(driverLayer, { excludeTestServices: true })(
  "AcpRegistryDriver model option discovery",
  (it) => {
    const makePerModelEffortAgent = Effect.fn("makePerModelEffortAgent")(function* (
      levels: Readonly<Record<string, ReadonlyArray<string> | null>>,
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const logPath = path.join(directory, "switches.log");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, perModelEffortAgentSource);
      yield* fileSystem.writeFileString(logPath, "");
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(levels));
      return {
        spawn: { command: process.execPath, args: [agentPath, logPath, modelsPath] },
        modelSwitches: fileSystem
          .readFileString(logPath)
          .pipe(Effect.map((log) => log.split("\n").filter((line) => line.length > 0))),
      };
    });
    const createRegistryInstance = (
      instanceId: ProviderInstanceId,
      spawn: { readonly command: string; readonly args: ReadonlyArray<string> },
      version: string,
    ) =>
      AcpRegistryDriver.create({
        instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version,
            distribution: "npx",
          }),
          resolve: () => Effect.succeed({ distribution: "npx" as const, spawn }),
        }),
      );
    const effortLevels = (snapshot: ServerProvider) =>
      snapshot.models
        .map((model) => {
          const effort = model.capabilities?.optionDescriptors?.find(
            (option) => option.id === "effort",
          );
          const levels = effort?.type === "select" ? effort.options.map((option) => option.id) : [];
          return `${model.slug}:${levels.join("+")}`;
        })
        .join();
    const refreshUntilEffortLevels = (
      instance: Effect.Success<ReturnType<typeof createRegistryInstance>>,
      expected: string,
    ) =>
      Effect.gen(function* () {
        const reached = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => effortLevels(snapshot) === expected),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        yield* Fiber.join(reached);
      });

    // A session's report: the model select plus the current model's own effort levels.
    const liveSession = (
      models: ReadonlyArray<string>,
      model: string,
      levels: ReadonlyArray<string>,
    ) =>
      normalizeAcpRegistryLiveConfiguration([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: models.map((value) => ({ value, name: value })),
        },
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: levels[0] ?? "",
          options: levels.map((value) => ({ value, name: value })),
        },
      ]);

    it.effect("reads each visible model's own reasoning levels before its first session", () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("acpRegistry_discovery");
        yield* (yield* TestProviderHost.TestProviderHostSettings).set({
          ...DEFAULT_SERVER_SETTINGS,
          favorites: [{ provider: instanceId, model: "fav" }],
          providerModelPreferences: { [instanceId]: { hiddenModels: ["hidden"], modelOrder: [] } },
        });
        const agent = yield* makePerModelEffortAgent({
          default: ["medium", "high"],
          plain: null,
          other: ["low", "high"],
          hidden: ["low"],
          fav: ["none", "max"],
        });
        const instance = yield* createRegistryInstance(instanceId, agent.spawn, "1.0.0");

        yield* refreshUntilEffortLevels(
          instance,
          "default:medium+high,plain:,other:low+high,hidden:,fav:none+max",
        );
        // Favorites first, hidden models skipped, then the agent's own model restored.
        expect(yield* agent.modelSwitches).toEqual(["fav", "plain", "other", "default"]);

        // What a live session reports for a model outranks what discovery read for it.
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const models = ["default", "plain", "other", "hidden", "fav"];
        const live = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              effortLevels(snapshot) === "default:high,plain:,other:xhigh,hidden:,fav:none+max",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* coordinator.publishLiveConfiguration(
          instanceId,
          liveSession(models, "other", ["xhigh"]),
        );
        yield* coordinator.publishLiveConfiguration(
          instanceId,
          liveSession(models, "default", ["high"]),
        );
        expect(Option.isSome(yield* Fiber.join(live))).toBe(true);
      }),
    );

    it.effect("reads every model of a catalog larger than one discovery batch in one refresh", () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("acpRegistry_large_catalog");
        const others = Array.from({ length: 30 }, (_, index) => `model-${index}`);
        yield* (yield* TestProviderHost.TestProviderHostSettings).set({
          ...DEFAULT_SERVER_SETTINGS,
          providerModelPreferences: {
            [instanceId]: { hiddenModels: [], modelOrder: [...others, "opus"] },
          },
        });
        const agent = yield* makePerModelEffortAgent({
          sonnet: ["medium"],
          ...Object.fromEntries(others.map((slug) => [slug, ["low"]])),
          opus: ["high", "max"],
        });
        const instance = yield* createRegistryInstance(instanceId, agent.spawn, "1.0.0");

        yield* refreshUntilEffortLevels(
          instance,
          ["sonnet:medium", ...others.map((slug) => `${slug}:low`), "opus:high+max"].join(),
        );
        expect(yield* agent.modelSwitches).toEqual([...others, "opus", "sonnet"]);
      }),
    );

    it.effect("keeps discovered reasoning levels across restarts until the agent updates", () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("acpRegistry_persisted");
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const agent = yield* makePerModelEffortAgent({
          default: ["medium", "high"],
          other: ["low", "high"],
        });
        const runInstance = (
          version: string,
          expected: string,
          then: (
            instance: Effect.Success<ReturnType<typeof createRegistryInstance>>,
          ) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
        ) =>
          Effect.scoped(
            createRegistryInstance(instanceId, agent.spawn, version).pipe(
              Effect.tap((instance) => refreshUntilEffortLevels(instance, expected)),
              Effect.flatMap(then),
            ),
          );

        yield* runInstance("1.0.0", "default:medium+high,other:low+high");
        expect(yield* agent.modelSwitches).toEqual(["other", "default"]);

        // Reused after a restart; a live session then replaces the stored levels.
        yield* runInstance("1.0.0", "default:medium+high,other:low+high", (instance) =>
          Effect.gen(function* () {
            const replaced = yield* instance.snapshot.streamChanges.pipe(
              Stream.filter((snapshot) => effortLevels(snapshot) === "default:high,other:xhigh"),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );
            const models = ["default", "other"];
            yield* coordinator.publishLiveConfiguration(
              instanceId,
              liveSession(models, "other", ["xhigh"]),
            );
            yield* coordinator.publishLiveConfiguration(
              instanceId,
              liveSession(models, "default", ["high"]),
            );
            yield* Fiber.join(replaced);
            // The session ends with this instance; only the stored levels remain.
            yield* coordinator.clearLiveConfiguration(instanceId);
          }),
        );
        expect(yield* agent.modelSwitches).toEqual(["other", "default"]);

        yield* runInstance("1.0.0", "default:medium+high,other:xhigh");
        expect(yield* agent.modelSwitches).toEqual(["other", "default"]);

        // An agent update makes every stored level stale.
        yield* runInstance("2.0.0", "default:medium+high,other:low+high");
        expect(yield* agent.modelSwitches).toEqual(["other", "default", "other", "default"]);
      }),
    );
  },
);

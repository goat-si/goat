import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { AcpRegistryDriver } from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";
import { acpRegistryEnvironmentKey } from "./sessionEnvironmentKey.ts";

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
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

const fakeAgentSource = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: modelIds[0],
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
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

const effortBySlug = (snapshot: ServerProvider) =>
  snapshot.models
    .map(
      (model) =>
        model.slug +
        ":" +
        (model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+"),
    )
    .join();

/** A session's configuration with an effort option for its model, from the environment it ran with. */
const sessionUnder = (environment: NodeJS.ProcessEnv, currentModelId: string) => ({
  ...normalizeAcpRegistryLiveConfiguration(
    [
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ],
    undefined,
    {
      currentModelId,
      availableModels: [
        { modelId: "model-a", name: "model-a" },
        { modelId: "model-b", name: "model-b" },
      ],
    },
  ),
  environmentKey: acpRegistryEnvironmentKey(environment),
});

const ready = {
  status: "ready",
  agentId: "test-agent",
  version: "1.0.0",
  distribution: "npx",
} as const;

/** An instance on profile A whose agent reports model-a and model-b; the host can move. */
const makeProfiles = Effect.fn("makeProfiles")(function* (
  inspect?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["inspect"],
  getLiveConfiguration?: (
    real: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"],
  ) => AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"]["getLiveConfiguration"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-learned-" });
  const agentPath = path.join(directory, "agent.mjs");
  const modelsPath = path.join(directory, "models.json");
  yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
  yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
  const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
  const host: NodeJS.ProcessEnv = { HOME: "/profile/a", PATH: "/fixture" };
  const instance = yield* AcpRegistryDriver.create({
    instanceId: identity.instanceId,
    displayName: identity.displayName,
    enabled: true,
    environment: [],
    config: decodeSettings({ agentId: "test-agent" }),
  }).pipe(
    Effect.provideService(HostProcess.Environment, host),
    Effect.provideService(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator, {
      ...coordinator,
      ...(getLiveConfiguration === undefined
        ? {}
        : { getLiveConfiguration: getLiveConfiguration(coordinator) }),
    }),
    Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
      ...catalogWithInspection(ready),
      ...(inspect === undefined ? {} : { inspect }),
      resolve: () =>
        Effect.succeed({
          distribution: "npx" as const,
          spawn: { command: process.execPath, args: [agentPath, modelsPath] },
        }),
    }),
  );
  /** The first published snapshot that matches, from now on. */
  const showing = (matches: (snapshot: ServerProvider) => boolean) =>
    instance.snapshot.streamChanges.pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.forkScoped({ startImmediately: true }),
    );
  const publish = (currentModelId: string) =>
    coordinator.publishLiveConfiguration(
      identity.instanceId,
      sessionUnder({ ...host }, currentModelId),
    );
  return { instance, coordinator, host, showing, publish };
});

it.layer(driverLayer, { excludeTestServices: true })("AcpRegistryDriver learned models", (it) => {
  it.effect("a session under a new profile builds on nothing learned under the old one", () =>
    Effect.gen(function* () {
      const { instance, host, showing, publish } = yield* makeProfiles();
      const probed = yield* showing((snapshot) => effortBySlug(snapshot) === "model-a:,model-b:");
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* showing(
        (snapshot) => effortBySlug(snapshot) === "model-a:effort,model-b:",
      );
      yield* publish("model-a");
      yield* Fiber.join(learned);
      // The snapshot still shows profile A's options; no check has run under B.
      host.HOME = "/profile/b";
      const fromB = yield* showing((snapshot) => effortBySlug(snapshot).includes("model-b:effort"));
      yield* publish("model-b");
      expect(effortBySlug(yield* Fiber.join(fromB))).toBe("model-a:,model-b:effort");
    }),
  );

  it.effect("an empty or partial update under an unchecked profile clears the old options", () =>
    Effect.gen(function* () {
      const { instance, coordinator, host, showing, publish } = yield* makeProfiles();
      const probed = yield* showing((snapshot) => effortBySlug(snapshot) === "model-a:,model-b:");
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* showing(
        (snapshot) => effortBySlug(snapshot) === "model-a:effort,model-b:",
      );
      yield* publish("model-a");
      yield* Fiber.join(learned);
      host.HOME = "/profile/b";
      // Every snapshot published until B's own options show, in order; the first one is the
      // snapshot shown right after B's empty update.
      const published = yield* instance.snapshot.streamChanges.pipe(
        Stream.map(effortBySlug),
        Stream.takeUntil((models) => models.includes("model-b:effort")),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      // B sessions report nothing, then options without a model list, then a model list.
      const underB = { environmentKey: acpRegistryEnvironmentKey({ ...host }) };
      yield* coordinator.publishLiveConfiguration(identity.instanceId, {
        ...normalizeAcpRegistryLiveConfiguration([], undefined, undefined),
        ...underB,
      });
      yield* coordinator.publishLiveConfiguration(identity.instanceId, {
        ...sessionUnder({ ...host }, "model-a"),
        models: [],
      });
      yield* publish("model-b");
      expect(yield* Fiber.join(published)).toEqual([
        "model-a:,model-b:",
        "model-a:,model-b:effort",
      ]);
    }),
  );

  it.effect("a check keeps the current profile's configuration after a late one from another", () =>
    Effect.gen(function* () {
      const { instance, coordinator, host, showing, publish } = yield* makeProfiles();
      const probed = yield* showing((snapshot) => effortBySlug(snapshot) === "model-a:,model-b:");
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      host.HOME = "/profile/b";
      yield* instance.snapshot.refresh;
      const learned = yield* showing((snapshot) =>
        effortBySlug(snapshot).includes("model-b:effort"),
      );
      yield* publish("model-b");
      yield* Fiber.join(learned);
      // A session still running under A reports last, so the coordinator now holds A's.
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        sessionUnder({ ...host, HOME: "/profile/a" }, "model-a"),
      );
      expect(effortBySlug(yield* instance.snapshot.refresh)).toBe("model-a:,model-b:effort");
    }),
  );

  it.effect("a check whose environment changes while it runs is redone under the current one", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const forkedCheckInspected = yield* Deferred.make<void>();
      let inspections = 0;
      let armed = false;
      // An agent that is not installed starts no background probe, so only checks inspect.
      const notFound = { status: "not_found", agentId: "test-agent" } as const;
      const { instance, host, publish } = yield* makeProfiles((_settings, environment) => {
        if (!armed || environment?.HOME !== "/profile/c") {
          inspections++;
          return (
            inspections === 2 ? Deferred.succeed(forkedCheckInspected, undefined) : Effect.void
          ).pipe(Effect.as(notFound));
        }
        armed = false;
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(notFound),
        );
      });
      // The initial snapshot inspects during create; until the test checks, the only other caller
      // is the forked creation-time check, which holds the refresh permit, so a refresh started
      // after its inspection runs after it.
      yield* Deferred.await(forkedCheckInspected);
      yield* instance.snapshot.refresh;
      yield* publish("model-a");
      expect(effortBySlug(yield* instance.snapshot.refresh)).toBe("model-a:effort,model-b:");
      armed = true;
      host.HOME = "/profile/c";
      const check = yield* instance.snapshot.refresh.pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.await(reached);
      // Readiness ran under C; the host returns to A before the check reads the live state, so
      // the check reads readiness again under A and shows what A's sessions taught.
      host.HOME = "/profile/a";
      yield* Deferred.succeed(release, undefined);
      expect(effortBySlug(yield* Fiber.join(check))).toBe("model-a:effort,model-b:");
    }),
  );

  it.effect("a check that outlives its profile does not commit over the next profile", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Only the readiness of the one check fiber the test holds; other callers pass through.
      let heldFiber: number | undefined;
      const { instance, host, showing, publish } = yield* makeProfiles((_settings) => {
        if (heldFiber === undefined || Fiber.getCurrent()?.id !== heldFiber) {
          return Effect.succeed(ready);
        }
        heldFiber = undefined;
        // Not installed under A, so no probe would restore B's options after A commits.
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ status: "not_found", agentId: "test-agent" } as const),
        );
      });
      const probed = yield* showing((snapshot) => effortBySlug(snapshot) === "model-a:,model-b:");
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const check = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
      heldFiber = check.id;
      yield* Deferred.await(reached);
      // The held check read profile A; B becomes current and a B session teaches an option.
      host.HOME = "/profile/b";
      const learned = yield* showing((snapshot) =>
        effortBySlug(snapshot).includes("model-b:effort"),
      );
      yield* publish("model-b");
      yield* Fiber.join(learned);
      yield* Deferred.succeed(release, undefined);
      expect(effortBySlug(yield* Fiber.join(check))).toBe("model-a:,model-b:effort");
      expect(effortBySlug(yield* instance.snapshot.getSnapshot)).toBe("model-a:,model-b:effort");
    }),
  );

  it.effect("a check whose profile changes while it reads the live state is redone", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The one check fiber the test holds: its first readiness reports A's agent missing, so no
      // probe could restore B, and it waits while reading the live state, after readiness.
      let heldFiber: number | undefined;
      let heldReadiness = true;
      const isHeld = () => heldFiber !== undefined && Fiber.getCurrent()?.id === heldFiber;
      const { instance, host, showing, publish } = yield* makeProfiles(
        () => {
          if (!isHeld() || !heldReadiness) return Effect.succeed(ready);
          heldReadiness = false;
          return Effect.succeed({ status: "not_found", agentId: "test-agent" } as const);
        },
        (real) => (instanceId) => {
          if (!isHeld()) return real.getLiveConfiguration(instanceId);
          heldFiber = undefined;
          return Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(real.getLiveConfiguration(instanceId)),
          );
        },
      );
      const probed = yield* showing((snapshot) => effortBySlug(snapshot) === "model-a:,model-b:");
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const check = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
      heldFiber = check.id;
      yield* Deferred.await(reached);
      // Readiness under A is done; B becomes current and a B session teaches an option.
      host.HOME = "/profile/b";
      const learned = yield* showing((snapshot) =>
        effortBySlug(snapshot).includes("model-b:effort"),
      );
      yield* publish("model-b");
      yield* Fiber.join(learned);
      yield* Deferred.succeed(release, undefined);
      expect(effortBySlug(yield* Fiber.join(check))).toBe("model-a:,model-b:effort");
      expect(effortBySlug(yield* instance.snapshot.getSnapshot)).toBe("model-a:,model-b:effort");
    }),
  );

  it.effect("options learned under one profile are not shown under another", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const host: NodeJS.ProcessEnv = { HOME: "/profile/a", PATH: "/fixture" };
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const effortBySlug = (snapshot: ServerProvider) =>
        snapshot.models
          .map(
            (model) =>
              model.slug +
              ":" +
              (model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+"),
          )
          .join();
      const waitFor = (expected: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => effortBySlug(snapshot) === expected),
          Stream.runHead,
        );
      // A session's configuration, attributed to the environment it ran with.
      const sessionUnder = (environment: NodeJS.ProcessEnv, currentModelId: string) => ({
        ...normalizeAcpRegistryLiveConfiguration(
          [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
          undefined,
          {
            currentModelId,
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b" },
            ],
          },
        ),
        environmentKey: acpRegistryEnvironmentKey(environment),
      });
      const profileA = { ...host };
      const probed = yield* waitFor("model-a:,model-b:").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* waitFor("model-a:effort,model-b:").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        sessionUnder(profileA, "model-a"),
      );
      yield* Fiber.join(learned);
      host.HOME = "/profile/b";
      // Profile B's own check shows nothing learned under A.
      expect(effortBySlug(yield* instance.snapshot.refresh)).not.toContain("effort");
      // A late update from a session still running under A, then one from a session under B.
      const settled = yield* waitFor("model-a:,model-b:effort").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        sessionUnder(profileA, "model-a"),
      );
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        sessionUnder({ ...host }, "model-b"),
      );
      expect(Option.isSome(yield* Fiber.join(settled))).toBe(true);
    }),
  );
});

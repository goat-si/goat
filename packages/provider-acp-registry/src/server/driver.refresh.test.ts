import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { describe, expect, it } from "@effect/vitest";
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
import {
  AcpRegistryDriver,
  buildCheckedAcpRegistrySnapshot,
  isAcpRegistryCacheValid,
  updateAcpRegistryEnrichmentCache,
} from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:acpRegistry_test",
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

const providerWithModels = (
  models: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: null }>,
  currentModelId: string,
): ServerProvider =>
  buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "test-agent" }),
    checkedAt: "2026-01-01T00:00:00.000Z",
    inspection: {
      status: "ready",
      agentId: "test-agent",
      version: "1.0.0",
      distribution: "npx",
    },
    probe: {
      probe: {
        instanceId: identity.instanceId,
        ready: true,
        icon: null,
        authMethods: [],
        sessionManagement: {
          canList: false,
          canLoad: false,
          canResume: false,
          canLogout: false,
          canDelete: false,
          canConfigureProviders: false,
        },
        models,
        currentModelId,
        configOptions: [],
      },
      slashCommands: [],
      skills: [],
    },
  });

describe("AcpRegistryDriver enrichment cache validation", () => {
  it("preserves cache generation and expiry on options-only live updates", () => {
    const optionsOnly = {
      models: [],
      currentModelId: "qmodel",
      configOptions: [],
      modelsFromModelSelect: false,
    };
    const emptyCache = { generation: 4, entry: null };
    expect(
      updateAcpRegistryEnrichmentCache({
        cache: emptyCache,
        configuration: optionsOnly,
        customModels: [],
        now: 5_000,
      }),
    ).toBe(emptyCache);

    const provider = providerWithModels(
      [
        { id: "auto", name: "Auto", description: null },
        { id: "qmodel", name: "QModel", description: null },
      ],
      "auto",
    );
    const populatedCache = { generation: 2, entry: { provider, expiresAt: 1_000 } };
    const updated = updateAcpRegistryEnrichmentCache({
      cache: populatedCache,
      configuration: optionsOnly,
      customModels: [],
      now: 5_000,
    });
    expect(updated.generation).toBe(2);
    expect(updated.entry?.expiresAt).toBe(1_000);
    expect(updated.entry?.provider.models.find((m) => m.slug === "qmodel")?.isDefault).toBe(true);
  });

  it("invalidates cached enrichment when launchIdentity changes at the same version", () => {
    const provider = providerWithModels([{ id: "m1", name: "M1", description: null }], "m1");
    expect(
      isAcpRegistryCacheValid(
        { provider, launchIdentity: "id-a", expiresAt: 1000 },
        "1.0.0",
        false,
        500,
        "id-a",
      ),
    ).toBe(true);
    expect(
      isAcpRegistryCacheValid(
        { provider, launchIdentity: "id-a", expiresAt: 1000 },
        "1.0.0",
        false,
        500,
        "id-b",
      ),
    ).toBe(false);
  });
});

it.layer(driverLayer, { excludeTestServices: true })(
  "AcpRegistryDriver refresh and live superseding",
  (it) => {
    it.effect(
      "refreshes stale registry indexes in the background for installed and uninstalled agents",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "acp-driver-upd-",
          });
          const agentPath = path.join(directory, "agent.mjs");
          const modelsPath = path.join(directory, "models.json");
          yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
          yield* fileSystem.writeFileString(
            modelsPath,
            JSON.stringify(["model-v1", "other-model"]),
          );

          let inspection: AcpRegistrySupport.AcpRegistryInspection = {
            status: "unsupported",
            agentId: "test-agent",
            version: "1.0.0",
          };
          let invalidations = 0;
          let refreshes = 0;

          const instance = yield* AcpRegistryDriver.create({
            instanceId: ProviderInstanceId.make("acpRegistry_refresh_index"),
            displayName: identity.displayName,
            enabled: true,
            environment: [],
            config: decodeSettings({ agentId: "test-agent" }),
          }).pipe(
            Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
              ...catalogWithInspection(inspection),
              inspect: () => Effect.sync(() => inspection),
              invalidateIndex: () =>
                Effect.sync(() => {
                  invalidations += 1;
                }),
              refreshIndex: () =>
                Effect.sync(() => {
                  refreshes += 1;
                  if (inspection.status === "unsupported") {
                    inspection = {
                      status: "ready",
                      agentId: "test-agent",
                      version: "1.0.0",
                      distribution: "npx",
                      launchIdentity: "v1",
                    };
                    return true;
                  }
                  if (
                    invalidations > 0 &&
                    inspection.status === "ready" &&
                    inspection.version === "1.0.0"
                  ) {
                    inspection = {
                      status: "ready",
                      agentId: "test-agent",
                      version: "2.0.0",
                      distribution: "npx",
                      launchIdentity: "v2",
                    };
                    return true;
                  }
                  return false;
                }),
              resolve: () =>
                Effect.succeed({
                  distribution: "npx" as const,
                  spawn: { command: process.execPath, args: [agentPath, modelsPath] },
                }),
            }),
          );

          const waitForVersion = (version: string) =>
            instance.snapshot.streamChanges.pipe(
              Stream.filter(
                (snapshot) =>
                  snapshot.installed &&
                  snapshot.version === version &&
                  snapshot.models.some((model) => model.slug === `model-v${version[0]}`),
              ),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );

          const recovered = yield* waitForVersion("1.0.0");
          yield* instance.snapshot.refresh;
          expect(Option.isSome(yield* Fiber.join(recovered))).toBe(true);
          expect(refreshes).toBeGreaterThanOrEqual(1);

          yield* fileSystem.writeFileString(
            modelsPath,
            JSON.stringify(["model-v2", "other-model"]),
          );
          const upgraded = yield* waitForVersion("2.0.0");
          yield* instance.invalidateCaches ?? Effect.void;
          expect(invalidations).toBe(1);
          yield* instance.snapshot.refresh;
          expect(Option.isSome(yield* Fiber.join(upgraded))).toBe(true);
        }),
    );

    it.effect(
      "supersedes stale live session models on a fresh probe while letting newer live sessions win",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "acp-driver-live-",
          });
          const agentPath = path.join(directory, "agent.mjs");
          const modelsPath = path.join(directory, "models.json");
          yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
          yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-a", "new-b"]));
          const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
          const instanceId = ProviderInstanceId.make("acpRegistry_periodic_supersede");

          let resolveGate:
            | {
                readonly entered: Deferred.Deferred<void>;
                readonly release: Deferred.Deferred<void>;
              }
            | undefined;

          const instance = yield* AcpRegistryDriver.create({
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
                version: "1.0.0",
                distribution: "npx",
              }),
              resolve: (_settings, _cwd, _env, options) =>
                Effect.gen(function* () {
                  const gate = options?.allowInstall === false ? resolveGate : undefined;
                  if (gate !== undefined) {
                    yield* Deferred.succeed(gate.entered, undefined);
                    yield* Deferred.await(gate.release);
                  }
                  return {
                    distribution: "npx" as const,
                    spawn: { command: process.execPath, args: [agentPath, modelsPath] },
                  };
                }),
            }),
          );

          const waitForModels = (expected: ReadonlyArray<string>) =>
            instance.snapshot.streamChanges.pipe(
              Stream.map((snapshot) => snapshot.models.map((model) => model.slug)),
              Stream.filter((slugs) => slugs.join() === expected.join()),
              Stream.runHead,
              Effect.forkScoped({ startImmediately: true }),
            );

          // Stale session catalog already present before a fresh probe runs.
          yield* coordinator.publishLiveConfiguration(
            instanceId,
            normalizeAcpRegistryLiveConfiguration([], undefined, {
              currentModelId: "old-a",
              availableModels: [
                { modelId: "old-a", name: "old-a" },
                { modelId: "old-b", name: "old-b" },
              ],
            }),
          );

          const superseded = yield* waitForModels(["old-a", "new-b"]);
          yield* instance.snapshot.refresh;
          expect(Option.isSome(yield* Fiber.join(superseded))).toBe(true);
          expect(Option.isNone(yield* coordinator.getLiveConfiguration(instanceId))).toBe(true);

          // Next readiness check keeps the accepted catalog after live config was cleared.
          yield* instance.snapshot.refresh;
          expect((yield* instance.snapshot.getSnapshot).models.map((m) => m.slug)).toEqual([
            "old-a",
            "new-b",
          ]);

          // A newer live update published while a probe is in flight is preserved after probe reconciliation.
          yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-a", "probed-c"]));
          resolveGate = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          yield* instance.invalidateCaches ?? Effect.void;
          yield* instance.snapshot.refresh;
          yield* Deferred.await(resolveGate.entered);

          const optionsOnlyLive = normalizeAcpRegistryLiveConfiguration(
            [],
            undefined,
            {
              currentModelId: "probed-c",
              availableModels: [
                { modelId: "old-a", name: "old-a" },
                { modelId: "probed-c", name: "probed-c" },
              ],
            },
            { includeCatalog: false },
          );
          yield* coordinator.publishLiveConfiguration(instanceId, optionsOnlyLive);

          const reconciled = yield* waitForModels(["old-a", "probed-c"]);
          yield* Deferred.succeed(resolveGate.release, undefined);
          expect(Option.isSome(yield* Fiber.join(reconciled))).toBe(true);
          // The live update that arrived mid-probe was not cleared by the older probe.
          expect(Option.isSome(yield* coordinator.getLiveConfiguration(instanceId))).toBe(true);
          expect(
            (yield* instance.snapshot.getSnapshot).models.find((m) => m.slug === "probed-c")
              ?.isDefault,
          ).toBe(true);
        }),
    );
  },
);

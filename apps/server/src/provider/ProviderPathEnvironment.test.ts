// @effect-diagnostics nodeBuiltinImport:off -- util.inspect shows whether a spawn environment is a plain object.
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as OpenCodeRuntime from "@goat/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@goat/provider-opencode/server/OpenCodeServerLedger";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeApplyDesktopShellEnvironmentSnapshot } from "../resourceTelemetry/DesktopShellEnvironmentReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import { HostPathChanged } from "./hostPathChanged.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import { layerHydrationTestServices } from "./ProviderInstanceRegistryHydration.testkit.ts";
import * as ProviderPathRefresh from "./ProviderPathRefresh.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");
const EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const SENTENCE = "GOAT has not been able to read the PATH from your login shell";

const disabled = (...drivers: ReadonlyArray<string>) =>
  Object.fromEntries(
    drivers.map((driver) => [
      ProviderInstanceId.make(driver),
      { driver: ProviderDriverKind.make(driver), enabled: false },
    ]),
  );

/** The real registry with real Claude and Codex driver instances; `spawned` records every launch. */
const layerRealProviders = (
  spawned: Array<string>,
  environments: Array<NodeJS.ProcessEnv | undefined>,
) =>
  ProviderRegistry.layer.pipe(
    Layer.provideMerge(
      ProviderInstanceRegistryHydration.layer.pipe(Layer.provide(layerHydrationTestServices)),
    ),
    Layer.provideMerge(AntigravityInstallation.AntigravityInstallation.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providerInstances: {
          ...disabled("cursor", "grok", "opencode"),
          [CLAUDE]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
          // One variable of its own puts this instance on the merged-environment path.
          [CODEX]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            environment: [{ name: "GOAT_TEST_INSTANCE_VARIABLE", value: "1", sensitive: false }],
          },
        },
      }),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "goat-provider-path-environment-" }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
        ),
      ).pipe(Layer.provideMerge(ModelManifest.layerTest)),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
    Layer.provideMerge(OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest))),
    Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          spawned.push([command.command, ...command.args].join(" "));
          environments.push(command.options.env);
        }
        return spawner.spawn(command);
      }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
          endpoint: Effect.succeed("unused-private-pipe"),
        }),
        Layer.mock(CodexInstallation.CodexInstallation)({
          managedDirectory: "unused-managed-installation",
        }),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          ),
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          reportClientActivity: () => Effect.void,
          removeRpcClient: () => Effect.void,
          reportHostPowerState: () => Effect.void,
          snapshot: Effect.succeed({
            hostPower: {
              source: "unknown",
              idle: "unknown",
              idleSeconds: null,
              locked: "unknown",
              suspended: false,
              onBattery: "unknown",
              lowPowerMode: "unknown",
              thermalState: "unknown",
              stale: true,
              updatedAt: EPOCH,
            },
            leases: [],
            activeForegroundLeaseCount: 0,
            activeScopeKeys: [],
            shouldRunOpportunisticWork: true,
            updatedAt: EPOCH,
          }),
          streamChanges: Stream.empty,
          hasDemand: () => Effect.succeed(true),
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
      ),
    ),
  );

/** One per status check: Claude asks for its version, Codex starts its app-server. */
const statusChecks = (spawned: ReadonlyArray<string>) => ({
  claude: spawned.filter((launch) => launch === "claude --version").length,
  codex: spawned.filter((launch) => /^codex .*app-server/u.test(launch)).length,
});

it.live(
  "real Claude and Codex instances created before the PATH was read find their CLI once it is",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      if (platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-path-environment-" });
      const bin = path.join(home, ".local", "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(
        path.join(bin, "claude"),
        "#!/bin/sh\necho '2.1.0 (Claude Code)'\n",
        {
          mode: 0o755,
        },
      );
      yield* fs.writeFileString(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.200.0'\n", {
        mode: 0o755,
      });

      // The drivers read the process environment itself, as they do in the server.
      const environment = process.env;
      const saved = {
        PATH: environment.PATH,
        pending: environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING,
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          environment.PATH = saved.PATH;
          if (saved.pending === undefined) delete environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING;
          else environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING = saved.pending;
        }),
      );
      environment.PATH = "/usr/bin:/bin";
      environment.GOAT_DESKTOP_SHELL_DISCOVERY_PENDING = "1";

      const spawned: Array<string> = [];
      const environments: Array<NodeJS.ProcessEnv | undefined> = [];
      const changed = Latch.makeUnsafe(false);
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(
        environment,
        platform,
        Effect.asVoid(changed.open),
      );

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const read = (instanceId: ProviderInstanceId) =>
          registry.getProviders.pipe(
            Effect.map((providers) =>
              providers.find((provider) => provider.instanceId === instanceId),
            ),
          );

        yield* registry.refresh();
        const before = statusChecks(spawned);
        expect((yield* read(CLAUDE))?.installed).toBe(false);
        expect((yield* read(CLAUDE))?.message).toContain(SENTENCE);
        expect((yield* read(CODEX))?.installed).toBe(false);
        expect((yield* read(CODEX))?.message).toContain(SENTENCE);

        const followUp = yield* ProviderPathRefresh.refreshOnPathChange.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* applySnapshot({
          version: 1,
          type: "shellEnvironment",
          platform,
          discovered: true,
          environment: { PATH: bin + ":/usr/bin:/bin" },
        });
        yield* Fiber.join(followUp);

        const claude = yield* read(CLAUDE);
        const codex = yield* read(CODEX);
        expect({
          claude: {
            installed: claude?.installed,
            version: claude?.version,
            sentence: (claude?.message ?? "").includes(SENTENCE),
          },
          codex: {
            installed: codex?.installed,
            sentence: (codex?.message ?? "").includes(SENTENCE),
          },
          checks: statusChecks(spawned),
        }).toEqual({
          claude: { installed: true, version: "2.1.0", sentence: false },
          codex: { installed: true, sentence: false },
          checks: { claude: before.claude + 1, codex: before.codex + 1 },
        });

        // What a provider is started with stays an ordinary object, with the new PATH in it.
        const started = environments[spawned.lastIndexOf("claude --version")] ?? {};
        expect(Object.getPrototypeOf(started)).toBe(Object.prototype);
        expect(started.PATH).toBe(bin + ":/usr/bin:/bin");
        expect(NodeUtil.inspect(started)).toContain("CLAUDE_CODE_ENTRYPOINT: 't3-code'");
        expect(structuredClone(started)).toEqual(started);
      }).pipe(
        Effect.provide(layerRealProviders(spawned, environments)),
        Effect.provideService(HostPathChanged, changed),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

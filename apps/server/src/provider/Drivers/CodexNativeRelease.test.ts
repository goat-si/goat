import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@goat/provider-core/server/maintenanceResolver";
import { CodexDriver } from "./CodexDriver.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderHostLive from "../ProviderHostLive.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(HostProcess.Environment, { PATH: "" })),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(MemoryDerivedCache.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);

it.layer(layerTest)("Codex native release", (it) => {
  // regression: #23937 `codex update` installs the native channel's release, which can lag npm.
  it.effect("does not advertise npm's latest Codex to a standalone install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = NodePath.join(tempDir, "codex-home");
      const binaryPath = NodePath.join(home, "packages", "standalone", "current", "bin", "codex");
      yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);
      // npm's latest tag is ahead of the native channel, as during a staggered release.
      const npmView = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "view") {
          return Effect.die("Version lookup must not run a provider or updater");
        }
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make('"0.164.0"')),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-standalone-latest"),
        displayName: "Codex standalone",
        enabled: false,
        environment: [],
        config: { ...CodexDriver.defaultConfig(), binaryPath, homePath: home },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, npmView),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === "https://releases.openai.com/codex/channels/latest"
                  ? Response.json({ tag_name: "rust-v0.163.0", assets: [] })
                  : new Response(null, { status: 404 }),
              ),
            ),
          ),
        ),
      );
      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update?.lockKey).toBe("codex-native");

      const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ version: "0.164.0" })),
            ),
          ),
        ),
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make(),
        ),
      );
      expect(latestVersion).toBe("0.163.0");
      expect(
        createProviderVersionAdvisory({
          driver: CodexDriver.driverKind,
          currentVersion: "0.163.0",
          latestVersion,
          maintenanceCapabilities: capabilities,
        }).status,
      ).not.toBe("behind_latest");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- the stop intent and process records use a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@goat/shared/observability";
import * as OtelEnvironment from "@goat/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as DesktopStopIntentReader from "./desktopStopIntent.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import { layerTest as persistence } from "./orchestration-v2/FoundationPersistence.testkit.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as Recovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { makeDetachedAppServers } from "./provider/CodexDetachedAppServer.ts";
import * as CodexDetached from "./provider/CodexDetachedAppServerLive.ts";
import * as CodexSurvivors from "./provider/CodexSurvivors.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const threadId = ThreadId.make("survivor-thread");
const attemptId = RunAttemptId.make("attempt");
const summary = {
  terminalizedRuns: 0,
  stoppedSessions: 0,
  closedRequests: 0,
  retiredEffects: 0,
  requeuedEffects: 0,
};

const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getRecoveryThreadIds: () => Effect.succeed([threadId]),
  getRuntimeRecoveryProjection: () =>
    Effect.succeed({
      thread: { id: threadId, projectId: "project" },
      providerThreads: [
        { id: "pt", driver: "codex", providerSessionId: "session", cloudTask: undefined },
      ],
      runs: [
        {
          id: RunId.make("run"),
          status: "running",
          providerThreadId: "pt",
          providerInstanceId: ProviderInstanceId.make("codex"),
          activeAttemptId: attemptId,
        },
      ],
    } as never),
  getThreadRecords: () =>
    Effect.succeed({
      providerTurns: [
        { id: ProviderTurnId.make("turn"), runAttemptId: attemptId, status: "running", ordinal: 1 },
      ],
    } as never),
});

// Startup recovery is stubbed; the shutdown preparation is the real service's.
const recovery = Layer.effect(
  Recovery.ProviderRuntimeRecoveryService,
  Effect.map(Recovery.ProviderRuntimeRecoveryService, (real) => ({
    ...real,
    recover: Effect.succeed(summary),
    reconcile: () => Effect.succeed(summary),
  })),
).pipe(Layer.provide(Recovery.layer));

const config = Layer.unwrap(
  Effect.map(
    ServerConfig.deriveServerPaths("/stop-intent-project", undefined).pipe(
      Effect.provide(Path.layer),
    ),
    (paths) =>
      Layer.mock(ServerConfig.ServerConfig)({
        ...paths,
        baseDir: "/stop-intent-project",
        logLevel: "Error",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        staticDir: undefined,
        devAllowedOrigins: [],
        desktopBootstrapToken: undefined,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        mode: "web",
        cwd: "/stop-intent-project",
        host: "localhost",
        port: 3773,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        autoBootstrapProjectFromCwd: false,
      }),
  ),
);

const environment = Layer.mergeAll(
  config,
  NodeCrypto.layer,
  Path.layer,
  Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
  Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
  Layer.mock(CodexSurvivors.CodexSurvivors)({ list: Effect.succeed([]) }),
  Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
  Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
    configureConcurrency: () => Effect.void,
    runGeneralOnce: Effect.never,
    runControlOnce: Effect.never,
    runCleanupOnce: Effect.never,
    runStartOnce: Effect.never,
  }),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
    publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("stop-intent-environment"),
      label: "Test environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    }),
  }),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
    managed: false,
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
    prepareTrial: Effect.succeed(undefined),
  }),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({}),
  FileSystem.layerNoop({}),
  Layer.mock(HttpServer.HttpServer)({
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
  }),
);

/** Runs the server the way bin.ts does and stops it by interrupting that fiber, as SIGTERM does. */
const stopServer = (intent: "relaunch" | "quit" | "none") =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-stop-intent-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const intentPath = NodePath.join(directory, "intent.json");
    if (intent !== "none")
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          intentPath,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            reason: intent,
            requestedAt: "2026-01-01T00:00:00Z",
          }),
        ),
      );
    const signals: string[] = [];
    const opened = yield* Deferred.make<string>();
    const server = Effect.gen(function* () {
      let socketPath = "";
      let gone = false;
      const detached = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () =>
            Effect.sync(() => (gone ? [] : [{ pid: 4321, pgid: 4321, argv: socketPath }])),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid, signal) =>
          Effect.sync(() => {
            signals.push(signal);
            gone = true;
          }),
        socketDirectory: Effect.succeed("/tmp/goat-test/codex"),
        launch: () => Effect.succeed({ pid: 4321, exited: Effect.never }),
        connect: () =>
          Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
      });
      // The provider session owns the Codex instance and closes it after shutdown preparation.
      const session = yield* Scope.make();
      const settings = ServerSettings.layerTest({
        codexTurnsSurviveServerStop: "restart",
        continueThreadsAfterServerUpdate: false,
      });
      const dependencies = Layer.mergeAll(
        environment,
        DesktopStopIntentReader.layer(intentPath, process.pid).pipe(
          Layer.provide(NodeFileSystem.layer),
        ),
        Layer.succeed(CodexDetached.CodexDetachedAppServers, {
          ...detached,
          socketTransportEnabled: true,
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          shutdown: Scope.close(session, Exit.void),
        }),
      ).pipe(Layer.provideMerge(recovery), Layer.provideMerge(projections));
      return yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        yield* startup.awaitCommandReady;
        const instance = yield* detached
          .open({
            instanceId: "codex",
            providerSessionId: ProviderSessionId.make("session"),
            command: (path) =>
              Effect.sync(() => {
                socketPath = path;
                return { command: "codex", args: [path] };
              }),
          })
          .pipe(Scope.provide(session));
        yield* Deferred.succeed(opened, instance.record.name);
        return yield* Effect.never;
      }).pipe(
        Effect.provide(
          ServerRuntimeStartup.layerWithOptions().pipe(
            Layer.provide(dependencies),
            Layer.provide(Layer.mergeAll(persistence, settings)),
          ),
        ),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }).pipe(Effect.scoped);
    const fiber = yield* Effect.forkChild(server);
    const name = yield* Effect.raceFirst(
      Deferred.await(opened),
      Fiber.join(fiber).pipe(Effect.andThen(Effect.die("The server stopped before Codex opened."))),
    );
    yield* Fiber.interrupt(fiber);
    const record = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(directory, "codex-app-servers", name + ".json"), "utf8"),
    );
    const intentLeft = yield* Effect.promise(() =>
      NodeFSP.access(intentPath).then(
        () => true,
        () => false,
      ),
    );
    return { signals, recordState: JSON.parse(record).state, intentLeft };
  }).pipe(Effect.scoped);

it.effect("a SIGTERM-style stop keeps a running Codex turn for a desktop relaunch", () =>
  Effect.gen(function* () {
    const result = yield* stopServer("relaunch");
    assert.deepEqual(result, { signals: [], recordState: "running", intentLeft: false });
  }),
);

it.effect.each(["quit", "none"] as const)(
  "a SIGTERM-style stop terminates the Codex process without a relaunch intent (%s)",
  (intent) =>
    Effect.gen(function* () {
      const result = yield* stopServer(intent);
      assert.deepEqual(result, {
        signals: ["SIGTERM"],
        recordState: "terminating",
        intentLeft: false,
      });
    }),
);

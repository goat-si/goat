import { assert } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ProviderDriverKind,
  CommandId,
  EnvironmentId,
  type ServerLifecycleStreamEvent,
  type DesktopStopIntent,
} from "@goat/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@goat/shared/observability";
import * as OtelEnvironment from "@goat/shared/otelEnvironment";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as ServerConfig from "./config.ts";
import * as DesktopStopIntentReader from "./desktopStopIntent.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as CodexDetachedAppServerLive from "./provider/CodexDetachedAppServerLive.ts";
import * as CodexSurvivors from "./provider/CodexSurvivors.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

export type BootstrapScenario =
  | "disabled-codex"
  | "disabled-default"
  | "launch-failure"
  | "project-failure";

export const bootstrapScenario = (
  scenario: BootstrapScenario,
  shutdown: Effect.Effect<void> = Effect.void,
  ordering?: {
    log: string[];
    settings: Deferred.Deferred<void>;
    auxiliary: Deferred.Deferred<void>;
    checkHeartbeat?: Effect.Effect<void>;
    checkStopped?: Effect.Effect<void>;
  },
  intent: Option.Option<DesktopStopIntent> = Option.none(),
  readerEffect: Effect.Effect<Option.Option<DesktopStopIntent>> = Effect.succeed(intent),
  hold: Effect.Effect<void> = Effect.void,
  onGoalOpen?: () => void,
  cleanupFails = false,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("bootstrap-project");
      const instanceId = ProviderInstanceId.make(
        scenario === "disabled-default" ? "custom" : "codex",
      );
      const events: ServerLifecycleStreamEvent[] = [];
      const recovery = {
        terminalizedRuns: 0,
        stoppedSessions: 0,
        closedRequests: 0,
        retiredEffects: 0,
        requeuedEffects: 0,
      };
      const imports = { importedThreadCount: 0, importedMessageCount: 0 };
      const dependencies = Layer.mergeAll(
        Layer.succeed(DesktopStopIntentReader.DesktopStopIntentReader, {
          atShutdown: readerEffect,
        }),
        NodeCrypto.layer,
        Path.layer,
        Layer.mock(ServerConfig.ServerConfig)({
          ...(yield* ServerConfig.deriveServerPaths("/bootstrap-project", undefined).pipe(
            Effect.provide(Path.layer),
          )),
          baseDir: "/bootstrap-project",
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
          mode: ordering?.checkHeartbeat ? "desktop" : "web",
          cwd: "/bootstrap-project",
          host: "localhost",
          port: 3773,
          devUrl: undefined,
          noBrowser: true,
          startupPresentation: "browser",
          autoBootstrapProjectFromCwd: true,
        }),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          pendingThreadCount: Effect.succeed(0),
          reconcileShells: Effect.sync(() => {
            ordering?.log.push("legacy-import");
            return imports;
          }),
          importPendingTranscripts: Effect.succeed(imports),
        }),
        Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
          recover: Effect.sync(() => {
            ordering?.log.push("recovery");
            return recovery;
          }),
          prepareForShutdown: Effect.succeed({ candidates: 0, continued: 0 }),
          prepareForShutdownWithStopKind: () => Effect.succeed({ candidates: 0, continued: 0 }),
          reconcile: () => Effect.succeed(recovery),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
        Layer.mock(CodexSurvivors.CodexSurvivors)({
          list: Effect.succeed([]),
          classifyRecord: () => Effect.succeed({ type: "verified", pgid: 123, members: [] }),
        }),
        Layer.mock(CodexDetachedAppServerLive.CodexDetachedAppServers)({
          cleanup: cleanupFails ? Effect.die("cleanup failed") : Effect.succeed([]),
          loadRecords: Effect.succeed(
            onGoalOpen === undefined
              ? []
              : [
                  {
                    version: 1,
                    name: "codex-abcdefabcdef",
                    instanceId: "codex",
                    socketPath: "/tmp/goal.sock",
                    pgid: 123,
                    bootId: "boot",
                    state: "running",
                    stderrMode: "discard",
                    createdAt: "2026-01-01T00:00:00Z",
                    goalBlocks: [
                      { threadId: ThreadId.make("goal-thread"), nativeThreadId: "native-goal" },
                    ],
                  },
                ],
          ),
          beginServerShutdown: Effect.void,
          socketTransportEnabled: false,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("goal-thread"),
                projectId,
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                runtimeMode: "full-access",
                interactionMode: "default",
                worktreePath: "/workspace",
                deletedAt: null,
              },
              providerThreads: [],
              providerSessions: [],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          shutdown,
          open: () =>
            Effect.sync(() => {
              onGoalOpen?.();
              return {} as never;
            }),
        }),
        Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          configureConcurrency: () => Effect.void,
          runGeneralOnce: Effect.never,
          runControlOnce: Effect.never,
          runCleanupOnce: Effect.never,
          runStartOnce: Effect.never,
        }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) =>
            Effect.sync(() => {
              const published = { ...event, sequence: events.length + 1 };
              events.push(published);
              if (event.type === "ready") ordering?.log.push("ready");
              return published;
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: ordering
            ? Deferred.succeed(ordering.settings, undefined).pipe(Effect.asVoid)
            : Effect.void,
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            defaultModelSelection:
              scenario === "disabled-default" ? { instanceId, model: "custom-model" } : null,
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: false,
                config: {},
              },
            },
          }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("bootstrap-environment"),
            label: "Test environment",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: () =>
            scenario === "project-failure"
              ? Effect.die("project bootstrap failed")
              : Effect.succeed({
                  created: true,
                  project: {
                    id: projectId,
                    title: "Project",
                    workspaceRoot: "/bootstrap-project",
                    repositoryIdentity: null,
                    faviconPath: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                    deletedAt: null,
                    defaultModelSelection:
                      scenario === "disabled-default"
                        ? { instanceId, model: "custom-model" }
                        : null,
                  },
                }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          countThreads: () => Effect.succeed(0),
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [],
              archivedThreads: [],
              schemaVersion: 1,
              snapshotSequence: 0,
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) => {
            assert.equal(input.modelSelection.instanceId, instanceId);
            return scenario === "launch-failure"
              ? Effect.fail(
                  new ThreadLaunch.ThreadLaunchError({
                    operation: "create-thread",
                    commandId: CommandId.make("bootstrap-command"),
                    projectId,
                    cause: "test launch failure",
                  }),
                )
              : Effect.fail(
                  new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                );
          },
        }),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
          managed: false,
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
          prepareTrial: Effect.succeed(undefined),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(AnalyticsService.AnalyticsService)({}),
        // No provider logins or Connect link, so startup records no owners.
        FileSystem.layerNoop({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
      );
      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        if (ordering) {
          yield* Deferred.await(ordering.settings);
          yield* TestClock.adjust(0);
          assert.notInclude(ordering.log, "legacy-import");
          ordering.log.push("listening");
          yield* startup.markHttpListening;
          yield* TestClock.adjust(0);
          assert.include(ordering.log, "aux-parked");
          assert.notInclude(ordering.log, "legacy-import");
          yield* ordering.checkHeartbeat ?? Effect.void;
          yield* Deferred.succeed(ordering.auxiliary, undefined);
        } else yield* startup.markHttpListening;
        const ready = yield* Effect.exit(startup.awaitCommandReady);
        yield* ordering?.checkStopped ?? Effect.void;
        assert.equal(Exit.isSuccess(ready), scenario !== "project-failure");
        if (ordering && scenario !== "project-failure") {
          yield* TestClock.adjust(0);
          assert.deepStrictEqual(ordering.log, [
            "listening",
            "aux-parked",
            "legacy-import",
            "recovery",
            "ready",
          ]);
        }
        const welcome = events.find((event) => event.type === "welcome");
        if (scenario === "project-failure") {
          assert.isUndefined(welcome);
        } else {
          assert.isDefined(welcome);
          if (welcome?.type === "welcome") {
            assert.equal(welcome.payload.bootstrapProjectId, projectId);
            assert.isUndefined(welcome.payload.bootstrapThreadId);
          }
        }
        yield* hold;
      }).pipe(
        Effect.provide(
          ServerRuntimeStartup.layerWithOptions(
            ordering
              ? {
                  awaitAuxiliaryParked: Effect.sync(() => {
                    ordering.log.push("aux-parked");
                  }).pipe(Effect.andThen(Deferred.await(ordering.auxiliary))),
                }
              : undefined,
          ).pipe(Layer.provide(dependencies)),
        ),
        Effect.provideService(ServerActivation, Effect.never),
      );
    }),
  );

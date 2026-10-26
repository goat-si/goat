import * as DecisionService from "./goatclaw/DecisionService.ts";
import * as ChannelBotDirectory from "./channels/ChannelBotDirectory.ts";
import * as ChannelBotRegistry from "./channels/ChannelBotRegistry.ts";
import * as ChannelGateway from "./channels/ChannelGateway.ts";
import * as ChannelIdentityService from "./channels/ChannelIdentityService.ts";
import * as ChannelLedger from "./channels/ChannelLedger.ts";
import * as CloudMachineService from "./cloudMachines/CloudMachineService.ts";
import * as CodexRouteService from "./provider/CodexRouteService.ts";
import * as Handoffs from "./handoffs/Handoffs.ts";
import * as HostStatusMcpService from "./mcp/HostStatusMcpService.ts";
import * as HubParity from "./hub/HubParity.ts";
import * as HubMembership from "./hub/HubMembership.ts";
import * as OpenCodexSync from "./hub/OpenCodexSync.ts";
import * as ChildBootstrap from "./opencodex/OpenCodexChildBootstrap.ts";
import * as HubNodes from "./hubNodes/HubNodes.ts";
import * as HubProxySessions from "./hubProxy/HubProxySessions.ts";
import * as MemorySyncService from "./memory/MemorySyncService.ts";
import * as NoteWorkService from "./notes/NoteWorkService.ts";
import * as NotesService from "./notes/NotesService.ts";
import * as ProviderHostSync from "./provider/ProviderHostSync.ts";
import * as RemoteLaunchCatalog from "./remoteReports/RemoteLaunchCatalog.ts";
import * as SlackChannelSettings from "./channels/SlackChannelSettings.ts";
import * as SshHostSetup from "./sshRemote/SshHostSetup.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  SshWorkspaceError,
  SshWorkspaceLaunchInput,
  SshWorkspaceLaunchResult,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  WsSubscribeServerConfigRpc,
  type OrchestrationProjectShell,
  type OrchestrationV2StoredEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type SshWorkspaceFetchBackInput,
} from "@goat/contracts";
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as RelayClient from "@goat/shared/relayClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerConfigModule from "./config.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as LaunchWatchService from "./mcp/LaunchWatchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StrayProcesses from "./diagnostics/StrayProcesses.ts";
import * as StorageReclaim from "./storage/StorageReclaim.ts";
import * as HostPressureMonitor from "./fleet/pressure/HostPressureMonitor.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as CloudProviderAutoSetup from "./provider/CloudProviderAutoSetup.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as PreviewSessions from "./preview/PreviewSessions.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SshWorkspaceSync from "./sshRemote/SshWorkspaceSync.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as WorktreeCheckoutHealth from "./vcs/WorktreeCheckoutHealth.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import {
  layerWsRpc,
  makeMemoryImportHandlers,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  withLateEditorConfig,
  WS_RPC_SERVER_OPTIONS,
} from "./ws.ts";

const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

it.effect("sends a Defender result that missed the snapshot, once", () =>
  Effect.gen(function* () {
    const health = {
      worktreesDirectory: "C:\\Users\\super\\.goat\\worktrees",
      defender: "scanning" as const,
    };
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined as never),
      },
      Stream.make(health, health),
    ).pipe(Stream.runCollect);

    const snapshots = Array.from(events).filter((event) => event.type === "snapshot");
    assert.equal(snapshots.length, 1);
    const [late] = snapshots;
    if (late?.type === "snapshot") {
      assert.deepEqual(late.config.worktreeCheckoutHealth, health);
    }
  }),
);

it.effect("SSH workspace handlers delegate once and preserve typed errors", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          import("effect/rpc/RpcGroup").Rpcs<typeof WsRpcGroup>["_tag"],
          typeof WS_METHODS.sshWorkspaceLaunch | typeof WS_METHODS.sshWorkspaceFetchBack
        > => tag !== WS_METHODS.sshWorkspaceLaunch && tag !== WS_METHODS.sshWorkspaceFetchBack,
      ),
    );
    const launchInput = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchInput)({
      sourceProjectId: "source",
      destination: {
        connectionId: "saved",
        expectedEnvironmentId: "remote",
        target: { alias: "box", hostname: "box", username: null, port: null },
      },
      title: "Work",
      modelSelection: { instanceId: "codex", model: "model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      initialMessage: { text: "Implement" },
    });
    const launchOutput = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchResult)({
      operationId: "12345678",
      snapshotRef: "refs/goat/snapshots/12345678",
      snapshotOid: "a".repeat(40),
      remoteEnvironmentId: "remote",
      remoteProjectId: "rp",
      remoteThreadId: "rt",
      remoteRepoPath: "/home/test/.goat/repos/repo-12345678",
      branch: "goat/ssh/12345678",
    });
    const fetchInput = {
      target: launchInput.destination.target,
      remoteWorkspaceRoot: launchOutput.remoteRepoPath,
      branch: launchOutput.branch,
    };
    const fetchOutput = {
      sourceProjectId: launchInput.sourceProjectId,
      localWorkspaceRoot: "/repo",
      localRef: "refs/remotes/goat-ssh/box/goat/ssh/12345678",
      commitOid: "a".repeat(40),
      remoteBranch: fetchInput.branch,
    };
    const launches: SshWorkspaceLaunchInput[] = [];
    const fetches: SshWorkspaceFetchBackInput[] = [];
    let failure: SshWorkspaceError | undefined;
    const sync = Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({
      launch: (input) =>
        Effect.suspend(() => {
          launches.push(input);
          return failure ? Effect.fail(failure) : Effect.succeed(launchOutput);
        }),
      fetchBack: (input) =>
        Effect.suspend(() => {
          fetches.push(input);
          return failure ? Effect.fail(failure) : Effect.succeed(fetchOutput);
        }),
    });
    const handlers = group
      .toLayer(
        Effect.gen(function* () {
          const service = yield* SshWorkspaceSync.SshWorkspaceSync;
          return {
            [WS_METHODS.sshWorkspaceLaunch]: (input) => service.launch(input),
            [WS_METHODS.sshWorkspaceFetchBack]: (input) => service.fetchBack(input),
          };
        }),
      )
      .pipe(Layer.provide(sync));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          handlers,
          RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]),
        ),
      ),
    );
    assert.deepEqual(yield* client[WS_METHODS.sshWorkspaceLaunch](launchInput), launchOutput);
    assert.deepEqual(yield* client[WS_METHODS.sshWorkspaceFetchBack](fetchInput), fetchOutput);
    assert.deepEqual(launches, [launchInput]);
    assert.deepEqual(fetches, [fetchInput]);
    failure = new SshWorkspaceError({
      stage: "launch",
      code: "launch_uncertain",
      host: "box",
      operationId: "12345678",
    });
    assert.deepEqual(
      yield* client[WS_METHODS.sshWorkspaceLaunch](launchInput).pipe(Effect.flip),
      failure,
    );
    failure = new SshWorkspaceError({ stage: "fetch", code: "fetch_failed", host: "box" });
    assert.deepEqual(
      yield* client[WS_METHODS.sshWorkspaceFetchBack](fetchInput).pipe(Effect.flip),
      failure,
    );
    assert.lengthOf(launches, 2);
    assert.lengthOf(fetches, 2);
  }).pipe(Effect.scoped),
);

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({ kind: item.kind as string, sequence: item.sequence })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          getReviewLedgerEntries: () => Effect.die("unused review ledger query"),
          getShellSnapshot: () => Effect.die("shell resume must not load a full snapshot"),
          listActiveSubagentThreadIds: () => Effect.succeed([]),
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("an unavailable import runtime rejects before invoking the service facade", () =>
  Effect.gen(function* () {
    const handlers = yield* makeMemoryImportHandlers(
      Effect.succeed(["memory:write", "filesystem:read"]),
      ["memory:write", "filesystem:read"],
    ).pipe(
      Effect.provide(
        Layer.mock(MemoryService.MemoryService)({
          importPorts: {} as MemoryService.MemoryService["Service"]["importPorts"],
          importProvider: () => Effect.die("unavailable runtime must not call facade"),
        }),
      ),
    );
    const result = yield* handlers[WS_METHODS.memoryImportProvider]({
      action: "discover",
      memorySpaceId:
        "00000000-0000-4000-8000-000000000001" as import("@goat/contracts").MemorySpaceId,
      format: "codex",
    }).pipe(Effect.flip);
    assert.equal(result._tag, "MemoryRpcError");
    if (result._tag === "MemoryRpcError") assert.equal(result.code, "unavailable");
  }),
);

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(MemoryService.MemoryService)({
    importPorts: {} as MemoryService.MemoryService["Service"]["importPorts"],
  }),
  Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
  Layer.mock(ChannelBotDirectory.ChannelBotDirectory)({}),
  Layer.mock(ChannelBotRegistry.ChannelBotRegistry)({}),
  Layer.mock(ChannelGateway.ChannelGateway)({}),
  Layer.mock(ChannelIdentityService.ChannelIdentityService)({}),
  Layer.mock(ChannelLedger.ChannelLedger)({}),
  Layer.mock(CloudMachineService.CloudMachineService)({}),
  Layer.mock(CodexRouteService.CodexRouteService)({}),
  Layer.mock(Handoffs.Handoffs)({}),
  Layer.mock(HostStatusMcpService.HostStatusMcpService)({}),
  Layer.mock(HubParity.HubParity)({}),
  Layer.mock(HubMembership.HubMembership)({}),
  Layer.mock(OpenCodexSync.OpenCodexSync)({}),
  Layer.mock(ChildBootstrap.OpenCodexChildBootstrap)({}),
  Layer.mock(HubNodes.HubNodes)({}),
  Layer.mock(HubProxySessions.HubProxySessions)({}),
  Layer.mock(MemorySyncService.MemorySyncService)({}),
  Layer.mock(NoteWorkService.NoteWorkService)({}),
  Layer.mock(NotesService.NotesService)({}),
  Layer.mock(ProviderHostSync.ProviderHostSync)({}),
  Layer.mock(RemoteLaunchCatalog.RemoteLaunchCatalog)({}),
  Layer.mock(SlackChannelSettings.SlackChannelSettings)({}),
  Layer.mock(SshHostSetup.SshHostSetup)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CloudProviderAutoSetup.CloudProviderAutoSetup)({ apply: Effect.succeed([]) }),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({ capability: null }),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DecisionService.DecisionService)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(StrayProcesses.StrayProcesses)({}),
  Layer.mock(StorageReclaim.StorageReclaim)({}),
  Layer.mock(HostPressureMonitor.HostPressureMonitor)({}),
  Layer.mock(WorktreeCheckoutHealth.WorktreeCheckoutHealth)({
    current: Effect.succeed(null),
    subscribeChanges: Effect.succeed(Stream.empty),
  }),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(LaunchWatchService.LaunchWatchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);

const layerConfigSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "goat-config-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "preserves settings during discovery and keybindings during snapshot ACK at the config RPC boundary",
  () =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings.Keybindings;
      const settings = yield* ServerSettings.ServerSettingsService;
      const keybindingsSubscribed = yield* Deferred.make<void>();
      const settingsSubscribed = yield* Deferred.make<void>();
      const keybindingsChanges = keybindings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(keybindingsSubscribed, undefined)),
      );
      const settingsChanges = settings.subscribeChanges.pipe(
        Effect.tap(() => Deferred.succeed(settingsSubscribed, undefined)),
      );
      const initialKeybindings = (yield* keybindings.getSnapshot).keybindings;
      const discoveryStarted = yield* Deferred.make<void>();
      const finishDiscovery = yield* Deferred.make<void>();
      const responses = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const configRpcServices = Layer.mergeAll(
        layerUnusedConfigRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () =>
            Deferred.succeed(discoveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishDiscovery)),
              Effect.as([]),
            ),
          resolveFileManagerRevealKind: () => Effect.succeed(undefined),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          streamChanges: Stream.never,
        }),
        Layer.mock(UsageLimitSources.UsageLimitSources)({
          streamChanges: Stream.make([]),
          projectProviders: (providers) => Effect.succeed(providers),
        }),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
          resolveTargets: () => Effect.succeed([]),
        }),
        Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          scratchRoot: Effect.succeedNone,
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("config-test")),
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("config-test"),
            label: "Config test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          getDescriptor: () =>
            Effect.succeed({
              policy: "loopback-browser",
              bootstrapMethods: [],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "config-test-session",
            }),
        }),
        // Signal subscription on either accessor so the test also fails, rather
        // than hangs, against a handler that subscribes after the snapshot.
        Layer.succeed(Keybindings.Keybindings, {
          ...keybindings,
          streamChanges: Stream.unwrap(keybindingsChanges),
          subscribeChanges: keybindingsChanges,
        }),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          ...settings,
          streamChanges: Stream.unwrap(settingsChanges),
          subscribeChanges: settingsChanges,
        }),
        Layer.mock(PreviewSessions.PreviewSessions)({}),
      );
      const server = yield* RpcServer.makeNoSerialization(
        RpcGroup.make(WsSubscribeServerConfigRpc),
        {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) =>
            response._tag === "Chunk"
              ? Effect.forEach(response.values, (event) => Queue.offer(responses, event), {
                  discard: true,
                })
              : Effect.void,
        },
      ).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("config-test"),
              subject: "config-test",
              method: "browser-session-cookie",
              scopes: [],
            },
            {
              hasHost: Effect.succeed(false),
              attach: () => Stream.die("unused connection catalog"),
              respond: () => Effect.die("unused connection catalog"),
              invoke: () => Effect.die("unused connection catalog"),
            },
            { surface: "web" },
            {},
            yield* PreviewAutomationBroker.PreviewAutomationBroker,
            yield* ServerBrowser.ServerBrowser,
          ).pipe(Layer.provide(configRpcServices)),
        ),
      );
      const requestId = RpcMessage.RequestId("config");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerConfig,
        payload: {},
        headers: Headers.empty,
      });
      yield* Deferred.await(discoveryStarted);

      const duringDiscovery = yield* settings.updateSettings({ defaultAutoPull: true });
      yield* Deferred.succeed(finishDiscovery, undefined);
      const snapshot = yield* Queue.take(responses);
      assert.equal(snapshot.type, "snapshot");
      if (snapshot.type !== "snapshot") return yield* Effect.die("Missing initial snapshot");
      assert.isFalse(snapshot.config.settings.defaultAutoPull);
      assert.deepEqual(snapshot.config.keybindings, initialKeybindings);
      const duringAck = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+y",
        command: "terminal.toggle",
      });
      yield* acknowledge;
      yield* Deferred.await(keybindingsSubscribed);
      yield* Deferred.await(settingsSubscribed);

      // Later updates expose a dropped buffered event as a value mismatch, not a timeout.
      const latestSettings = yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      const latestKeybindings = yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+z",
        command: "terminal.split",
      });
      const expectedSettings = [duringDiscovery, latestSettings].map(
        ServerSettings.redactServerSettingsForClient,
      );
      const expectedKeybindings = [duringAck, latestKeybindings];
      // The two sources can interleave, but each must retain its own publication order.
      for (let i = 0; i < 4; i++) {
        const event = yield* Queue.take(responses);
        if (event.type === "settingsUpdated") {
          assert.deepEqual(event.payload.settings, expectedSettings.shift());
        } else {
          assert.equal(event.type, "keybindingsUpdated");
          if (event.type !== "keybindingsUpdated")
            return yield* Effect.die("Unexpected config event");
          assert.deepEqual(event.payload.keybindings, expectedKeybindings.shift());
          assert.deepEqual(event.payload.issues, []);
        }
        yield* acknowledge;
      }
      assert.isEmpty(expectedSettings);
      assert.isEmpty(expectedKeybindings);
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerConfigSources),
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

// Compaction keeps the oldest and newest event per message, so a cursor older
// than the deleted rows still replays each message where the client would
// first have seen it (reducers append on first sight) and reaches the same
// final state. No snapshot fallback is needed.
it.effect("thread resume across compacted history keeps message order and final state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:compacted");
    const insertMessage = (version: number, id: string, text: string) => sql<{
      sequence: number;
    }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`compacted:${version}`}, 'thread', ${threadId}, ${version}, 'message.updated',
        ${now}, 'server', ${JSON.stringify({
          createdBy: "user",
          creationSource: "web",
          id,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        })}, '{}', 2
      ) RETURNING sequence
    `;
    const [first] = yield* insertMessage(0, "message:a", "a created");
    const [second] = yield* insertMessage(1, "message:b", "b created");
    yield* insertMessage(2, "message:a", "a superseded");
    const [head] = yield* insertMessage(3, "message:a", "a final");
    // thread.deleted is never superseded: clients switch on the event type.
    for (const version of [0, 1]) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`deleted:${version}`}, 'thread', 'thread:deleted-twice', ${version}, 'thread.deleted',
          ${now}, 'server', '{}', '{}', 2
        )
      `;
    }
    // Only the event between a's first and newest is deleted.
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 1);

    const items = yield* subscribeOrchestrationV2Thread({
      threadId,
      afterSequence: first!.sequence - 1,
      requestCompletionMarker: true,
    }).pipe(
      Effect.flatMap((stream) =>
        stream.pipe(
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
      ),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.never,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items, (item) =>
        item.kind === "event"
          ? [item.sequence, item.event.type === "message.updated" ? item.event.payload.text : null]
          : [item.kind],
      ),
      [
        [first!.sequence, "a created"],
        [second!.sequence, "b created"],
        [head!.sequence, "a final"],
        ["synchronized"],
      ],
    );
  }).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(ReplayTestLayer),
      ),
    ),
  ),
);

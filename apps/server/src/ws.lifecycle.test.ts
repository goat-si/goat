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
import * as AcpRegistryRuntimeCoordinator from "@goat/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as RelayClient from "@goat/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
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
import * as DocumentText from "./provider/DocumentText.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
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
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
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
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
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
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, WS_METHODS, WsRpcGroup } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { layerWsRpc, WS_RPC_SERVER_OPTIONS } from "./ws.ts";

const layerLifecycleEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("lifecycle-test")),
  getDescriptor: Effect.succeed({
    environmentId: EnvironmentId.make("lifecycle-test"),
    label: "Lifecycle test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

// Build the production RPC layer; unrelated capabilities fail if this test calls them.
const layerUnusedLifecycleRpcServices = Layer.mergeAll(
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
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(PreviewSessions.PreviewSessions)({}),
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
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({ capability: null }),
  Layer.mock(SessionStore.SessionStore)({
    cookieName: "lifecycle-test",
    legacyCookieName: undefined,
  }),
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

const layerLifecycleSources = Layer.mergeAll(
  Keybindings.layer,
  ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer)),
).pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(
      ServerConfigModule.layerTest(process.cwd(), { prefix: "goat-lifecycle-subscription-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each([
  ["omitted", {}],
  ["false", { runtimeDrain: false }],
  ["true", { runtimeDrain: true }],
] as const)(
  "lifecycle RPC delivers initial state before ACK and filters drain events when runtimeDrain is %s",
  ([, input]) =>
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const closed = yield* Deferred.make<void>();
      yield* lifecycle.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: "running", totalThreadCount: 1 },
      });
      const drain = yield* lifecycle.publish({
        version: 1,
        type: "runtimeDrain",
        payload: {
          status: "draining",
          targetVersion: "1.0.0",
          deadline: "2026-10-28T00:00:00.000Z",
          forced: false,
        },
      });
      const migration = yield* lifecycle.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: "complete", totalThreadCount: 2 },
      });
      const rpc = WsRpcGroup.requests.get(WS_METHODS.subscribeServerLifecycle);
      if (rpc?._tag !== WS_METHODS.subscribeServerLifecycle) {
        return yield* Effect.die("Lifecycle RPC is not registered");
      }
      const responses = yield* Queue.unbounded<RpcMessage.FromServer<typeof rpc>>();
      const services = Layer.mergeAll(
        layerUnusedLifecycleRpcServices,
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(UsageLimitSources.UsageLimitSources)({}),
        Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
        Layer.mock(DirectEndpoints.DirectEndpoints)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({}),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        layerLifecycleEnvironment,
        Layer.succeed(ServerLifecycleEvents.ServerLifecycleEvents, {
          ...lifecycle,
          stream: lifecycle.stream.pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
        }),
      );
      const server = yield* RpcServer.makeNoSerialization(RpcGroup.make(rpc), {
        ...WS_RPC_SERVER_OPTIONS,
        onFromServer: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
      }).pipe(
        Effect.provide(
          layerWsRpc(
            {
              sessionId: AuthSessionId.make("lifecycle-test"),
              subject: "lifecycle-test",
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
          ).pipe(Layer.provide(services)),
        ),
      );
      const requestId = RpcMessage.RequestId("lifecycle");
      const acknowledge = server.write(0, { _tag: "Ack", requestId });
      yield* server.write(0, {
        _tag: "Request",
        id: requestId,
        tag: WS_METHODS.subscribeServerLifecycle,
        payload: input,
        headers: Headers.empty,
      });
      const initial = yield* Queue.take(responses);
      assert.equal(initial._tag, "Chunk");
      if (initial._tag !== "Chunk") return yield* Effect.die("Missing lifecycle replay");
      const receivesDrain = "runtimeDrain" in input && input.runtimeDrain === true;
      assert.deepEqual(initial.values, receivesDrain ? [drain, migration] : [migration]);

      if (drain.type !== "runtimeDrain") return yield* Effect.die("Missing runtime drain");
      const cancelled = yield* lifecycle.publish({
        version: 1,
        type: "runtimeDrain",
        payload: { ...drain.payload, status: "cancelled" },
      });
      const latest = yield* lifecycle.publish({
        version: 1,
        type: "legacyThreadMigration",
        payload: { status: "complete", totalThreadCount: 3 },
      });
      yield* acknowledge;
      const expected = receivesDrain ? [cancelled, latest] : [latest];
      const live = yield* Stream.fromQueue(responses).pipe(
        Stream.mapEffect((response) =>
          Effect.gen(function* () {
            assert.equal(response._tag, "Chunk");
            if (response._tag !== "Chunk") return yield* Effect.die("Lifecycle RPC ended");
            yield* acknowledge;
            return response.values;
          }),
        ),
        Stream.flatMap((events) => Stream.fromIterable(events)),
        Stream.take(expected.length),
        Stream.runCollect,
      );
      assert.deepEqual(live, expected);
      yield* server.write(0, { _tag: "Interrupt", requestId, interruptors: [] });
      yield* Deferred.await(closed);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.fresh(layerLifecycleSources),
          ServerLifecycleEvents.layer,
          Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
        ),
      ),
      Effect.scoped,
    ),
);

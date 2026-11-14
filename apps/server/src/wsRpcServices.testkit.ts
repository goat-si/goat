import * as ShellSnapshotLoads from "./orchestration-v2/ShellSnapshotLoads.ts";
import * as DecisionService from "./goatclaw/DecisionService.ts";
import * as ChannelBotDirectory from "./channels/ChannelBotDirectory.ts";
import * as ChannelBotMembers from "./channels/ChannelBotMembers.ts";
import { wsHandlerMocks } from "./wsHandlerMocks.testkit.ts";
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
import * as DisposableAttach from "./hub/disposable/DisposableAttach.ts";
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
import { EnvironmentId } from "@goat/contracts";
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
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as AttachmentLifecycle from "./assets/AttachmentLifecycle.testkit.ts";
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
import * as ProviderInstallation from "./provider/providerInstallation.ts";
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
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as PreviewSessions from "./preview/PreviewSessions.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlStarPrompt from "./sourceControl/SourceControlStarPrompt.ts";
import * as SshWorkspaceSync from "./sshRemote/SshWorkspaceSync.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import { ThreadWorkspaceService } from "./orchestration-v2/goat/ThreadWorkspaceService.ts";
import * as WorktreeCheckoutHealth from "./vcs/WorktreeCheckoutHealth.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

/** Services behind ws.ts for tests that assemble its RPC layer; most are empty mocks. */
export const layerConfigEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("config-test")),
  getDescriptor: Effect.succeed({
    environmentId: EnvironmentId.make("config-test"),
    label: "Config test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});
export const layerUnusedConfigRpcServices = Layer.mergeAll(
  Layer.mock(ShellSnapshotLoads.ShellSnapshotLoads)({}),
  Layer.mock(MemoryService.MemoryService)({
    importPorts: {} as MemoryService.MemoryService["Service"]["importPorts"],
  }),
  Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
  Layer.mock(ChannelBotDirectory.ChannelBotDirectory)({}),
  Layer.mock(ChannelBotRegistry.ChannelBotRegistry)({}),
  Layer.mock(ChannelBotMembers.ChannelBotMembers)({}),
  wsHandlerMocks,
  Layer.mock(ChannelGateway.ChannelGateway)({}),
  Layer.mock(ChannelIdentityService.ChannelIdentityService)({}),
  Layer.mock(ChannelLedger.ChannelLedger)({}),
  Layer.mock(CloudMachineService.CloudMachineService)({}),
  Layer.mock(CodexRouteService.CodexRouteService)({}),
  Layer.mock(Handoffs.Handoffs)({}),
  Layer.mock(HostStatusMcpService.HostStatusMcpService)({}),
  Layer.mock(HubParity.HubParity)({}),
  Layer.mock(HubMembership.HubMembership)({}),
  Layer.mock(DisposableAttach.DisposableAttach)({}),
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
  AttachmentLifecycle.layerUnused,
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
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CloudProviderAutoSetup.CloudProviderAutoSetup)({ apply: Effect.succeed([]) }),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
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
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({ capability: null }),
  Layer.mock(SessionStore.SessionStore)({ cookieName: "config-test", legacyCookieName: undefined }),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlStarPrompt.SourceControlStarPrompt)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(ThreadWorkspaceService)({}),
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
export const layerConfigSources = Layer.mergeAll(
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

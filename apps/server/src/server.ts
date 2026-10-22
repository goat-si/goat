import * as HostPressureMonitor from "./fleet/pressure/HostPressureMonitor.ts";
import * as DecisionInbox from "./goatclaw/DecisionInbox.ts";
import * as PermissionProfiles from "./goatclaw/PermissionProfiles.ts";
import * as PendingQuestionsMcpService from "./mcp/PendingQuestionsMcpService.ts";
// @effect-diagnostics nodeBuiltinImport:off - the closed import factory requires a synchronous UUID callback.
import { isGoatConnectEnabled } from "@goat/shared/goatConnect";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath } from "@goat/shared/shell";
import { desiredLinkReconcileStartup } from "./cloud/DesiredLinkReconcile.ts";
import * as NotesLayers from "./notes/NotesLayers.ts";
import * as HomeRequests from "./provider/CodexHomeRequests.ts";
import * as CodexRoutes from "./provider/CodexRouteService.ts";
import * as HomeRoute from "./provider/OpenCodexRoute.ts";
import * as ProviderOnboarding from "./provider/ProviderOnboarding.ts";
import * as CloudProviderAutoSetup from "./provider/CloudProviderAutoSetup.ts";
import * as SshDeviceAdd from "./sshRemote/SshDeviceAdd.ts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as ChannelLayers from "./channels/ChannelLayers.ts";
import * as CloudAgentService from "./cloudAgents/CloudAgentService.ts";
import * as BoatClient from "./cloudMachines/BoatClient.ts";
import * as CloudMachineService from "./cloudMachines/CloudMachineService.ts";
import * as CloudMachineSsh from "./cloudMachines/sshConfig.ts";
import * as ConnectionCatalogBroker from "./connections/ConnectionCatalogBroker.ts";
import * as GoalLayers from "./fleet/goals/GoalLayers.ts";
import * as FleetHealth from "./fleet/health/layer.ts";
import * as HandoffExpiry from "./handoffs/HandoffExpiry.ts";
import * as HubDown from "./hub/HubDown.ts";
import * as HubNodeRepository from "./hubNodes/HubNodeRepository.ts";
import * as HubNodes from "./hubNodes/HubNodes.ts";
import * as LinkedHosts from "./linkedHosts/LinkedHosts.ts";
import * as HostThreadsMcpService from "./mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "./mcp/LaunchWatchService.ts";
import * as ThreadReplicaService from "./mcp/ThreadReplicaService.ts";
import * as McpToolAccess from "./mcp/McpToolAccess.ts";
import * as OrchestratorMcpService from "./mcp/OrchestratorMcpService.ts";
import * as ThreadLaunchMcpService from "./mcp/ThreadLaunchMcpService.ts";
import { invocationPermit, memoryError } from "./mcp/toolkits/memory/handlers.ts";
import { MemoryAdministrationToolkit } from "./mcp/toolkits/memoryAdministration/tools.ts";
import { parseClaudeMemory } from "./memory/imports/ClaudeMemoryImporter.ts";
import { parseCodexMemory } from "./memory/imports/CodexMemoryImporter.ts";
import {
  acquireMemoryImportReader,
  preflightMemoryImportStateDirectory,
  type MemoryImportReaderConfig,
} from "./memory/imports/MemoryImportReader.ts";
import { ProviderMemoryImportRuntime } from "./memory/imports/MemoryImportTypes.ts";
import { parseOmoMemory } from "./memory/imports/OmoMemoryImporter.ts";
import { makeProviderMemoryImport } from "./memory/imports/ProviderMemoryImport.ts";
import * as MemoryCompactor from "./memory/MemoryCompactor.ts";
import * as MemoryMaintenance from "./memory/MemoryFtsMaintenance.ts";
import * as MemoryGenerationHold from "./memory/MemoryGenerationHold.ts";
import * as MemoryHubAuth from "./memory/MemoryHubAuth.ts";
import * as MemoryHubHttp from "./memory/MemoryHubHttp.ts";
import * as MemoryHub from "./memory/MemoryHubService.ts";
import * as MemoryOwnerSourceReadPolicyBinding from "./memory/MemoryOwnerSourceReadPolicyBinding.ts";
import * as MemoryQuota from "./memory/MemoryQuotaService.ts";
import * as MemoryReportAdapter from "./memory/MemoryReportAdapter.ts";
import * as MemoryReportWorker from "./memory/MemoryReportWorker.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as MemorySettings from "./memory/MemorySettingsService.ts";
import * as MemorySnapshot from "./memory/MemorySnapshot.ts";
import * as MemorySnapshotBinding from "./memory/MemorySnapshotBinding.ts";
import * as MemoryStore from "./memory/MemoryStore.ts";
import * as MemorySyncRuntimeLive from "./memory/MemorySyncRuntimeLive.ts";
import * as MemorySync from "./memory/MemorySyncService.ts";
import * as MemoryWorker from "./memory/MemoryWorker.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as ThreadArchiveGate from "./orchestration-v2/ThreadArchiveGate.ts";
import * as ThreadHistoryArchive from "./orchestration-v2/ThreadHistoryArchive.ts";
import * as ThreadHistoryArchiveLabels from "./orchestration-v2/ThreadHistoryArchiveLabels.ts";
import * as ProviderDiagnosisRouting from "./provider/ProviderDiagnosisRouting.ts";
import * as ProviderHostSync from "./provider/ProviderHostSync.ts";
import * as RemoteDispatchCoordinator from "./remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteLaunchCatalog from "./remoteReports/RemoteLaunchCatalog.ts";
import * as RemoteReportService from "./remoteReports/RemoteReportService.ts";
import * as RuntimeAdmission from "./runtimeAdmission.ts";
import * as RuntimeControl from "./runtimeControl.ts";
import * as RuntimeDrain from "./runtimeDrain.ts";
import * as RuntimeIdentity from "./runtimeIdentity.ts";
import * as SshHostSetup from "./sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "./sshRemote/SshRemoteDispatch.ts";
import * as GoatclawFleetSync from "./goatclaw/FleetSync.ts";
import * as SshWorkspaceSync from "./sshRemote/SshWorkspaceSync.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as WorktreeCheckoutHealth from "./vcs/WorktreeCheckoutHealth.ts";
import * as ObservedCheckService from "./threadResults/ObservedCheckService.ts";
import * as ThreadResultService from "./threadResults/ThreadResultService.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  MemoryHubDisableInput,
  MemoryHubDisableResult,
  MemoryHubError,
  MemorySettingsUpdateInput,
  type RepositoryIdentity,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as CursorAccountReader from "@goat/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@goat/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@goat/provider-cursor/server/CursorUsageAccounts";
import * as OpenCodeRuntime from "@goat/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@goat/provider-opencode/server/OpenCodeServerLedger";
import * as NetService from "@goat/shared/Net";
import * as RelayClient from "@goat/shared/relayClient";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import { disableTailscaleServe, ensureTailscaleServe } from "@goat/tailscale";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as AuthHttp from "./auth/http.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import * as ReplayMarkers from "./auth/replayMarkers.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as ServerAutoUpdate from "./cloud/autoUpdate.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as CloudLink from "./cloud/CloudLink.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "./cloud/config.ts";
import * as ConnectReachability from "./cloud/ConnectReachability.ts";
import * as CloudHttp from "./cloud/http.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as RelayTracing from "./cloud/relayTracing.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as SshRuntimeAutoUpdate from "./cloud/sshRuntimeAutoUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { layerCommandReadiness } from "./commandReadiness.ts";
import * as ServerConfig from "./config.ts";
import * as CuaDriver from "./cua/CuaDriver.ts";
import * as ComputerUseLeases from "./cua/ComputerUseLeases.ts";
import * as ComputerUseLeaseRoute from "./cua/ComputerUseLeaseRoute.ts";
import * as DesktopAppUpdate from "./desktopUpdate/DesktopAppUpdate.ts";
import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as StrayProcesses from "./diagnostics/StrayProcesses.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as FleetFallback from "./fleet/resources/Fallback.ts";
import * as FleetPressure from "./fleet/pressure/PressureNudger.ts";
import * as FleetPlacement from "./fleet/resources/Placement.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ServerHttp from "./http.ts";
import { withUntracedRequests } from "./http.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import * as HubProxyHttp from "./hubProxy/http.ts";
import * as HubProxyNodes from "./hubProxy/HubProxyNodes.ts";
import * as HubProxySessions from "./hubProxy/HubProxySessions.ts";
import * as Keybindings from "./keybindings.ts";
import * as MaintenanceAudit from "./maintenance/MaintenanceAudit.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as Observability from "./observability/Observability.ts";
import * as CloudTaskSource from "./orchestration-v2/CloudTaskSourceService.ts";
import * as EventStoreV2 from "./orchestration-v2/EventStore.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as IdleCompactionService from "./orchestration-v2/IdleCompactionService.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./orchestration-v2/ProviderEventIngestor.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import { fixPath } from "./os-jank.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as DesktopBrowserChannel from "./preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ServerBrowserStream from "./preview/ServerBrowserStream.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GoatProjectFileLoader from "./project/GoatProjectFileLoader.ts";
import * as ProjectHttp from "./project/http.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as ProviderDiagnosisService from "./provider/ProviderDiagnosisService.ts";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as PullRequestHttp from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as HeldHooksWaker from "./relay/HeldHooksWaker.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ProcessGroupMetrics from "./resourceTelemetry/ProcessGroupMetrics.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as RelayDeliveryProof from "./scheduledTasks/RelayDeliveryProof.ts";
import {
  relayHookBaseUrl,
  ScheduledTaskWebhookOrigin,
} from "./scheduledTasks/ScheduledTaskService.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as ServerActivation from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { makePersistedServerRuntimeState } from "./serverRuntimeState.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import { loopbackUrlHostForAddress } from "./startupAccess.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./telemetry/DelegatedTaskAnalytics.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as CodexUsageHistory from "./usage/CodexUsageHistory.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as Ws from "./ws.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerResourceAttribution = ResourceAttribution.layer;
const layerApplicationObservability = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(layerResourceAttribution),
);

// One rotating store behind both logger views, so driver instances never race
// its rotation.
const layerProviderEventLoggers = Layer.effect(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

const layerPtyAdapter = NodePtyAdapter.layer;

const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const layerDesktopTelemetryReceiver = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(layerServerSettings),
);

const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(layerNativeTelemetry),
  Layer.provideMerge(layerDesktopTelemetryReceiver),
);

const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

// One self-healing instance for the fleet tools and the goal controller: one host monitor and one
// move lock. It gets the power monitor background policy uses, so suspend and resume reach it.
const layerFleetHealth = FleetHealth.layer.pipe(Layer.provide(layerHostPowerMonitor));

// Notices to orchestrating threads and launch advice; reads the monitor host status exposes.
const layerPressureAdmission = FleetPressure.layerAdmission.pipe(
  Layer.provide(HostPressureMonitor.layer),
);
const layerFleetPressure = FleetPressure.layer.pipe(
  Layer.provide(layerFleetHealth),
  Layer.provideMerge(layerPressureAdmission),
);
const layerThreadReplicas = ThreadReplicaService.layer.pipe(Layer.provide(layerPressureAdmission));
const layerLaunchWatches = LaunchWatchService.layer.pipe(
  Layer.provideMerge(layerThreadReplicas),
  Layer.provide(layerPressureAdmission),
);

// Reuses DesktopTelemetryReceiverLayerLive: a fresh receiver layer here
// would open a second reader on the desktop telemetry fd.
const layerDesktopAppUpdate = DesktopAppUpdate.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

const layerCuaDriver = CuaDriver.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
  Layer.provide(layerServerSettings),
);

const layerBackground = BackgroundPolicy.layer.pipe(
  Layer.provide(layerHostPowerMonitor),
  Layer.provideMerge(layerServerSettings),
);

const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AntigravityUsage.layer,
      CodexUsageHistory.layer,
      CursorUsageAccounts.layer.pipe(
        Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
      ),
    ).pipe(
      Layer.provide(
        ProviderHostLive.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerSettings),
);

const layerResourceDiagnostics = Layer.mergeAll(
  HostResources.layer,
  layerResourceTelemetry,
  ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessGroupMetrics.layer.pipe(Layer.provide(layerResourceTelemetry)),
);

const layerRelayClient = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return RelayClient.layerCloudflared({ baseDir: config.baseDir });
  }),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(
      () => rejectRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer())),
      {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      },
    );
  }),
);

const layerPlatformServices = NodeServices.layer;

const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerRepositoryIdentityResolver = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const kind of SourceControlBuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS.map(
          (driver) => driver.kind,
        )) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

const layerTextGeneration = TextGeneration.layer.pipe(
  Layer.provide(layerSourceControlProviderRegistry),
);

const layerGitManager = GitManager.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStoreV2.layer, ProjectStore.layer)),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerTextGeneration),
);

const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(GitVcsDriver.layer),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(GitVcsDriver.layer),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provideMerge(layerKnownWorkspaces),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(layerGitWorkflow),
      Layer.provide(VcsStatusBroadcaster.layerAutomaticFetchInterval),
      // The orchestration runtime also consumes the broadcaster (run
      // finalization), so the policy cannot read the store from the runtime's
      // output.
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerPortScanner = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const layerTerminal = TerminalManager.layer.pipe(
  Layer.provide(layerPtyAdapter),
  Layer.provide(layerPortScanner),
  Layer.provide(layerNativeTelemetry),
);

const layerPreview = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerPortScanner),
);

const layerDevice = DeviceService.layer.pipe(
  Layer.provide(layerServerSettings),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NetService.layer),
);

// One proxy session service for the /hub/nodes routes and the hubProxy RPCs, so unenrolling or
// removing a node ends every socket open to it. It reads the runtime's one HubNodes, and the same
// SshRemoteDispatch layer reference as the MCP tools, so the proxy shares their tunnel manager.
const layerHubProxy = HubProxySessions.layer.pipe(
  Layer.provideMerge(HubProxyNodes.layerFromHubNodes),
  Layer.provide(SshRemoteDispatch.layer),
);

const layerWorkspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(layerWorkspaceEntries),
  Layer.provide(layerKnownWorkspaces),
);

const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
);

const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(GoatProjectFileLoader.layer),
);

// Sync needs the core service at construction; source reads need Sync only at invocation.
// The application owns this single binding so neither service constructs a second core.
export class MemorySourceReadBinding extends Context.Service<
  MemorySourceReadBinding,
  {
    readonly readSource: MemoryService.MemorySourceReadAuthority["readSource"];
    readonly importSync: Pick<
      MemorySync.MemorySyncService["Service"],
      "readLocalReadiness" | "requireBootstrap" | "syncStatus"
    >;
    readonly bind: (sync: MemorySync.MemorySyncService["Service"]) => Effect.Effect<void>;
  }
>()("goat/server/MemorySourceReadBinding") {}
export const layerMemorySourceReadBinding = Layer.effect(
  MemorySourceReadBinding,
  Effect.gen(function* () {
    const current = yield* Ref.make<MemorySync.MemorySyncService["Service"] | null>(null);
    return MemorySourceReadBinding.of({
      readSource: (input, permit) =>
        Ref.get(current).pipe(
          Effect.flatMap((sync) =>
            sync === null
              ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
              : sync.readSource(input, permit),
          ),
        ),
      importSync: {
        readLocalReadiness: () =>
          Ref.get(current).pipe(
            Effect.flatMap((sync) =>
              sync === null
                ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                : sync.readLocalReadiness(),
            ),
          ),
        requireBootstrap: (space) =>
          Ref.get(current).pipe(
            Effect.flatMap((sync) =>
              sync === null
                ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                : sync.requireBootstrap(space),
            ),
          ),
        syncStatus: (input, permit) =>
          Ref.get(current).pipe(
            Effect.flatMap((sync) =>
              sync === null
                ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
                : sync.syncStatus(input, permit),
            ),
          ),
      },
      bind: (sync) => Ref.set(current, sync),
    });
  }),
);
// One layer reference for the worker and layerMemorySync, so the worker, conflict resolution and
// the status read share one set of holds. The registry supplies the provider version in each key.
const layerMemoryGenerationHold = MemoryGenerationHold.layer.pipe(
  Layer.provide(ProviderRegistry.layer),
);
const layerMemoryQuota = MemoryQuota.layer.pipe(Layer.provideMerge(MemoryStore.layer));
export const layerMemorySourceReadService = Layer.unwrap(
  Effect.gen(function* () {
    const binding = yield* MemorySourceReadBinding;
    return MemoryService.layerWithSourceReadAuthority(binding.readSource);
  }),
).pipe(Layer.provide(layerMemorySourceReadBinding));
const layerMemoryService = layerMemorySourceReadService.pipe(
  Layer.provide(layerServerSettings),
  Layer.provideMerge(layerMemoryQuota),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerRepositoryIdentityResolver),
  Layer.provide(layerPersistence),
);
const layerMemoryWorker = Layer.mergeAll(
  MemoryWorker.layer,
  MemoryReportWorker.layer.pipe(Layer.provide(MemoryReportAdapter.layer)),
).pipe(
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(layerMemoryService),
  Layer.provide(MemoryMaintenance.layer.pipe(Layer.provide(layerMemoryQuota))),
  Layer.provide(RuntimeLayer.layerEventSink),
  Layer.provide(layerTextGeneration),
  Layer.provide(RuntimeIdentity.layer),
  Layer.provide(layerMemoryGenerationHold),
);
const layerMemoryStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* MemoryWorker.MemoryWorker;
    yield* worker.start();
    const reports = yield* MemoryReportWorker.MemoryReportWorker;
    yield* reports.start();
  }),
).pipe(Layer.provideMerge(layerMemoryWorker));

// These layers are also used by the real-store HTTP scenarios. Dependencies are
// supplied by the application, so WP2 and the hub share one core and settings owner.
export const layerMemoryHubServices = Layer.mergeAll(
  MemoryHub.layer,
  MemoryHub.administratorLayer,
  MemoryCompactor.layer,
  MemoryHubAuth.layer,
).pipe(
  Layer.provideMerge(MemoryHub.activityLayer),
  Layer.provideMerge(
    Layer.effect(
      MemoryHub.MemoryHubConfiguration,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.MemoryHubCommittedSettings;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const hubEnvironmentId = yield* identity.getEnvironmentId;
        return MemoryHub.MemoryHubConfiguration.of({
          read: settings.read.pipe(
            Effect.map(({ settings: memoryHub }) =>
              memoryHub.mode === "hub" && memoryHub.memorySpaceId !== null
                ? { memorySpaceId: memoryHub.memorySpaceId, hubEnvironmentId }
                : null,
            ),
          ),
        });
      }),
    ),
  ),
);

// L3's interface tag has the L2 runtime key. Supply the actual instance, without
// constructing another service or introducing a per-request runtime.
const layerMemoryHubHttpService = Layer.effect(
  MemoryHubHttp.MemoryHubService,
  MemoryHub.MemoryHubService,
);
export const layerMemoryHubRoutes = MemoryHubHttp.layer.pipe(
  HttpRouter.provideRequest(layerMemoryHubHttpService),
  Layer.provide(layerMemoryHubHttpService),
);

export const layerMemoryHubStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const configuration = yield* MemoryHub.MemoryHubConfiguration;
    const store = yield* MemoryStore.MemoryStore;
    const compactor = yield* MemoryCompactor.MemoryCompactor;
    const applicationScope = yield* Scope.Scope;
    // Subscribe before readiness/read to retain a concurrent first enable.
    const changes = yield* settings.subscribeChanges;
    const readyPrincipal = Effect.gen(function* () {
      const hub = yield* configuration.read;
      if (!hub) return Option.none();
      return yield* store.transact(
        Effect.gen(function* () {
          const member = yield* store.readHubMember(hub.memorySpaceId, hub.hubEnvironmentId);
          const retention = yield* store.readHubRetentionTx(hub.memorySpaceId);
          if (!member || member.status !== "active" || retention.checkpointId === null)
            return yield* new MemoryHubError({ code: "bootstrap_required" });
          return Option.some({
            memorySpaceId: hub.memorySpaceId,
            environmentId: hub.hubEnvironmentId,
            credentialVersion: member.credentialVersion,
            scopes: ["memory:sync"] as const,
          });
        }),
      );
    });
    // One start in this application scope, after migrations, settings and the
    // published initial membership checkpoint. Disabled startup has no sweep.
    yield* Stream.concat(Stream.succeed(undefined), changes).pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const principal = yield* readyPrincipal;
          if (Option.isNone(principal)) return false;
          const startScope = yield* Scope.fork(applicationScope);
          yield* compactor.start(principal.value).pipe(
            Effect.provideService(Scope.Scope, startScope),
            // Release subscriptions from a failed sweep; a successful start
            // keeps its child scope until the application closes.
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(startScope, exit) : Effect.void,
            ),
          );
          return true;
        }).pipe(
          // Readiness and the initial sweep can race with disable. Keep the
          // settings subscription alive and retry on the next transition.
          Effect.catch((error) =>
            Effect.logWarning("Memory compactor startup deferred", { errorTag: error._tag }).pipe(
              Effect.as(false),
            ),
          ),
        ),
      ),
      Stream.filter((started) => started),
      Stream.take(1),
      Stream.runDrain,
      // Startup marks settings ready after building its dependencies. Await it
      // in the scoped fiber so acquisition cannot deadlock that startup.
      (run) => Effect.andThen(settings.ready, run),
      Effect.forkScoped,
    );
  }),
);

const layerMemoryHub = layerMemoryHubStarted.pipe(
  Layer.provideMerge(layerMemoryHubServices),
  Layer.provideMerge(layerMemoryService),
  Layer.provideMerge(layerServerSettings),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerSecretStore.layer),
);
const layerRegisteredMemoryHub = layerMemoryHubRoutes.pipe(
  HttpRouter.provideRequest(layerMemoryHub),
  Layer.provideMerge(layerMemoryHub),
);
export const layerMemoryDefaultStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* MemorySync.MemorySyncService;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.andThen(settings.ready, sync.initializeDefaultHub).pipe(
      Effect.catch(() =>
        Effect.logWarning("memory initialization unavailable", {
          code: "memory_default_unavailable",
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
export const layerMemorySyncStarted = Layer.merge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* MemorySync.MemorySyncService;
      const binding = yield* Effect.serviceOption(MemorySourceReadBinding);
      if (Option.isSome(binding)) yield* binding.value.bind(sync);
      yield* sync.start;
    }),
  ),
  layerMemoryDefaultStarted,
).pipe(Layer.provideMerge(MemorySync.layer));

/** Shared production runtime composition, including the single committed policy adapter. */
export const layerMemorySyncRuntime = MemorySyncRuntimeLive.layer.pipe(
  Layer.provideMerge(MemoryOwnerSourceReadPolicyBinding.layer),
);
const layerMemorySync = layerMemorySyncStarted.pipe(
  Layer.provide(layerMemorySourceReadBinding),
  Layer.provideMerge(layerMemorySyncRuntime),
  Layer.provide(layerMemoryHub),
  Layer.provide(layerTextGeneration),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerMemoryGenerationHold),
);

/** Acquisition is isolated from the core graph; only a fully acquired reader publishes the tag. */
export const layerMemoryImport = (config?: MemoryImportReaderConfig) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const service = yield* MemoryService.MemoryService;
      const { importSync: sync } = yield* MemorySourceReadBinding;
      const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const environmentId = yield* identity.getEnvironmentId;
      const server = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const gitExecutable =
        config === undefined ? yield* resolveCommandPath("git") : config.gitExecutable;
      const readerConfig = config ?? {
        stateDir: server.stateDir,
        ...(gitExecutable ? { gitExecutable } : {}),
        roots: [
          { format: "codex", rootSlot: "default", path: path.join(home, ".codex") },
          { format: "claude", rootSlot: "default", path: path.join(home, ".claude", "projects") },
          {
            format: "omo",
            rootSlot: "default",
            path: path.join(home, ".omo", "memory", "agents"),
          },
        ],
      };
      const reader = yield* preflightMemoryImportStateDirectory(readerConfig.stateDir).pipe(
        Effect.andThen(acquireMemoryImportReader(readerConfig)),
        Effect.result,
      );
      if (reader._tag === "Failure") {
        yield* Effect.logWarning("Provider memory import unavailable", {
          issue: reader.failure.issue,
          ...(reader.failure.issue === "path_rejected"
            ? {
                stateDir: readerConfig.stateDir,
                recovery:
                  "Match the stateDir owner to the server execution UID. If shared writes are not needed, remove group/other write permission and restart. If shared writes are needed, use a dedicated stateDir.",
              }
            : {}),
        });
        return Layer.empty;
      }
      return Layer.succeed(
        ProviderMemoryImportRuntime,
        makeProviderMemoryImport(
          {
            ...service.importPorts,
            readiness: sync.readLocalReadiness,
            requireBootstrap: sync.requireBootstrap,
            syncStatus: sync.syncStatus,
          },
          reader.success,
          { codex: parseCodexMemory, claude: parseClaudeMemory, omo: parseOmoMemory },
          {
            uuid: () => NodeCrypto.randomUUID(),
            now: () => Clock.currentTimeMillis,
            environmentId,
          },
        ),
      );
    }),
  );
const layerProviderMemoryImport = layerMemoryImport().pipe(
  Layer.provide(layerMemoryService),
  Layer.provide(layerMemorySourceReadBinding),
  Layer.provide(ServerEnvironment.layerIdentity),
);

export const layerMemorySnapshot = MemorySnapshot.layer;
export const provideMemorySnapshot = MemorySnapshotBinding.provide;
const layerMemorySnapshotWithDependencies = layerMemorySnapshot.pipe(
  Layer.provide(layerMemorySync),
  Layer.provide(layerMemoryService),
  Layer.provide(layerMemoryQuota),
  Layer.provide(ProjectionStoreV2.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerPersistence),
);

const decodeMemoryHubDisable = Schema.decodeUnknownEffect(MemoryHubDisableInput);
const decodeMemoryHubDisabled = Schema.decodeUnknownEffect(MemoryHubDisableResult);
export const layerMemoryHubAdministration = Layer.effect(
  ServerSettings.MemoryHubAdministration,
  Effect.gen(function* () {
    const sync = yield* MemorySync.MemorySyncService;
    return ServerSettings.MemoryHubAdministration.of({
      disableHub: (input, permit) =>
        decodeMemoryHubDisable(input).pipe(
          Effect.flatMap((value) =>
            sync.updateHubSettings(
              { ...value, action: "configure", settings: { mode: "disabled" } },
              permit,
            ),
          ),
          Effect.flatMap((result) =>
            decodeMemoryHubDisabled({
              settings: result.view.settings,
              version: result.view.version,
            }),
          ),
          Effect.mapError(memoryError),
        ),
    });
  }),
);

// The application supplies settings administration without exposing hub credentials.
const layerMemoryAdministrationToolkit = McpHttpServer.toolkitRegistration(
  MemoryAdministrationToolkit,
  McpToolAccess.toLayer(
    MemoryAdministrationToolkit,
    Effect.gen(function* () {
      const service = yield* ServerSettings.MemoryHubAdministration;
      const memorySettings = yield* MemorySettings.MemorySettingsService;
      return {
        memory_settings_get: McpToolAccess.reads(() =>
          Effect.gen(function* () {
            return yield* memorySettings.get(yield* invocationPermit("read"));
          }).pipe(Effect.mapError(memoryError)),
        ),
        memory_settings_update: McpToolAccess.writesWithCapability((input) =>
          Effect.gen(function* () {
            return yield* memorySettings.update(
              yield* Schema.decodeUnknownEffect(MemorySettingsUpdateInput)(input),
              yield* invocationPermit("settings"),
            );
          }).pipe(Effect.mapError(memoryError)),
        ),
        memory_hub_disable: McpToolAccess.writesWithCapability((input) =>
          Effect.gen(function* () {
            return yield* service.disableHub(
              yield* decodeMemoryHubDisable(input),
              yield* invocationPermit("settings"),
            );
          }).pipe(Effect.mapError(memoryError)),
        ),
      };
    }),
  ),
).pipe(Layer.provide(layerMemoryHubAdministration), Layer.provide(MemorySettings.layer));

export const layerMemoryToolkits = Layer.mergeAll(
  McpHttpServer.layerMemoryToolkit,
  layerMemoryAdministrationToolkit,
);

const layerServerEnvironment = ServerEnvironment.layer.pipe(
  Layer.provide(layerProviderMemoryImport),
  Layer.provide(layerRegisteredMemoryHub),
  Layer.provide(layerServerSettings),
  Layer.provide(ServerSecretStore.layer),
);

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

const layerCloudManagedEndpointRuntime = Layer.mergeAll(
  layerRelayClient,
  CloudManagedEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerRelayClient),
  ),
);

const layerScheduledTaskWebhookOrigin = Layer.effect(
  ScheduledTaskWebhookOrigin,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return Effect.gen(function* () {
      if (!isGoatConnectEnabled())
        return { relayHookBaseUrl: null, unavailableReason: "relay_not_linked" as const };
      const secretsRead = yield* Effect.all([
        secrets.get(RELAY_URL_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ]).pipe(Effect.option);
      // A failed read says nothing about the link, so it reports no reason.
      if (Option.isNone(secretsRead)) return { relayHookBaseUrl: null };
      const [relayUrl, tunnelConfig] = secretsRead.value;
      if (Option.isNone(relayUrl)) {
        return { relayHookBaseUrl: null, unavailableReason: "relay_not_linked" as const };
      }
      if (Option.isNone(tunnelConfig)) {
        return {
          relayHookBaseUrl: null,
          unavailableReason: "managed_tunnel_not_configured" as const,
        };
      }
      const config = decodeRuntimeConfig(new TextDecoder().decode(tunnelConfig.value));
      const base = relayHookBaseUrl({
        relayUrl: new TextDecoder().decode(relayUrl.value),
        tunnelName: Option.isSome(config) ? config.value.tunnelName : undefined,
      });
      return base === null
        ? { relayHookBaseUrl: null, unavailableReason: "managed_tunnel_unrecognized" as const }
        : { relayHookBaseUrl: base };
    });
  }),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerScheduledTaskWebhookOrigin),
  Layer.provide(ProviderEventIngestor.layerAnalytics),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const layerOrchestrationApplication = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerOrchestrationV2Runtime),
);

const layerThreadSettlementWorker = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService), Layer.provide(ProjectionStoreV2.layer));

const layerObservedCheckWorker = Layer.effectDiscard(
  ObservedCheckService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(ProjectionStoreV2.layer), Layer.provide(RuntimeLayer.layerProjectService));
const layerIdleCompactionWorker = Layer.effectDiscard(
  IdleCompactionService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(ProjectionStoreV2.layer));

const layerThreadPullRequestWorker = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService));

const layerProviderInstallationRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
    const codex = yield* CodexInstallation.CodexInstallation;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* Stream.merge(
      antigravity.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
      codex.changes.pipe(
        Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
        Stream.drop(1),
      ),
    ).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const layerCloudMachines = CloudMachineService.layerWithoutDependencies.pipe(
  Layer.provide(BoatClient.layer),
  Layer.provide(CloudMachineSsh.layer()),
);

const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
  layerMemoryStarted,
  layerMemorySync,
  layerProviderMemoryImport,
  AgentAwarenessRelay.layer,
  HeldHooksWaker.layer,
  layerThreadSettlementWorker,
  layerObservedCheckWorker,
  layerIdleCompactionWorker,
  StorageCleanup.layer.pipe(Layer.provide(ProjectionStoreV2.layer)),
  WorktreeCheckoutHealth.layer.pipe(Layer.provide(ProcessRunner.layer)),
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(ThreadHistoryArchive.layer),
    Layer.provide(
      Layer.merge(EventStoreV2.layerFromOrchestrationEventStore, ProjectionStoreV2.layer),
    ),
  ),
  ThreadHistoryArchiveLabels.layer.pipe(Layer.provide(ThreadHistoryArchive.layer)),
  StrayProcesses.layer.pipe(Layer.provide(ProcessRunner.layer)),
  layerThreadPullRequestWorker,
  DelegatedTaskAnalytics.layer,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provideMerge(PullRequestSyncReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provide(PullRequestWatchReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(ProjectionStoreV2.layer),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(ProjectionStoreV2.layer)),
  ProviderUsageLimitsIngestion.layer,
  layerProviderInstallationRefresh,
  ReplayMarkers.layer,
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
).pipe(
  // The same hub layer backs routes, descriptors and future L4 application consumers.
  Layer.provideMerge(layerMemoryHub),
  // GOAT bot and channel input sit on top of orchestration and are shared by WS and MCP.
  // Same EventSink layer reference as orchestration, so memoization shares one instance.
  // Remote channel workers reach other machines through the same SshRemoteDispatch layer
  // reference the MCP tools use, so both share one tunnel manager and session cache.
  Layer.provideMerge(
    ChannelLayers.layer.pipe(
      Layer.provide(RuntimeLayer.layerEventSink),
      Layer.provide(SshRemoteDispatch.layer),
      // GOAT Bot searches memory when it answers; same references, so one memory instance.
      Layer.provide(Layer.merge(layerMemoryService, layerMemorySync)),
    ),
  ),
  Layer.provideMerge(layerHubProxy),
  Layer.provideMerge(
    HubNodes.layer.pipe(
      Layer.provide(HubNodeRepository.layer),
      Layer.provide(SshRemoteDispatch.layer),
    ),
  ),
  // One cloud machine service for WS, MCP and both SshRemoteDispatch builds, so the
  // per-alias readiness lock and SSH cache invalidation span every caller.
  Layer.provideMerge(layerCloudMachines),
  // Hosts linked over HTTPS, for the same SshRemoteDispatch builds and the MCP link tools.
  Layer.provideMerge(LinkedHosts.layer),
  Layer.provideMerge(
    DecisionInbox.layerRunning.pipe(
      Layer.provideMerge(DecisionInbox.layer),
      Layer.provide(PermissionProfiles.layer),
      Layer.provide(
        PendingQuestionsMcpService.layer.pipe(
          Layer.provide(HostThreadsMcpService.layer),
          Layer.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
            ),
          ),
          Layer.provide(ThreadResultService.layer),
        ),
      ),
      Layer.provide(RemoteDispatchCoordinator.layer),
      Layer.provide(layerLaunchWatches),
      Layer.provide(SshRemoteDispatch.layer),
      Layer.provideMerge(layerOrchestrationApplication),
    ),
  ),
  Layer.provideMerge(
    RuntimeDrain.layer.pipe(
      // One instance, shared with the auto-update scheduler, so arbitration sees its target.
      Layer.provide(SshRuntimeAutoUpdate.layerArbiter),
      Layer.provideMerge(SshRuntimeAutoUpdate.layer),
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(RuntimeDrain.layerShutdown),
      Layer.provideMerge(RuntimeAdmission.layer),
      Layer.provideMerge(RuntimeIdentity.layer),
    ),
  ),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  // pipe takes at most 20 steps, so the Cua Driver and cloud auto setup join this merge.
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectStore.layer,
      ThreadSearch.layer,
      layerCuaDriver,
      ComputerUseLeases.layer,
      CloudProviderAutoSetup.layer,
    ),
  ),
  Layer.provideMerge(layerServerSettings),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview, layerDevice)),
  Layer.provideMerge(layerPersistence),
  Layer.provideMerge(Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer)),
  Layer.provideMerge(Layer.merge(ProviderRegistry.layer, UsageLimitSources.layer)),
  (application) =>
    provideMemorySnapshot(
      application,
      ProviderInstanceRegistryHydration.layer.pipe(
        Layer.provide(
          layerPullRequestService.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
        ),
        Layer.provide(ProjectionStoreV2.layer),
      ),
      layerMemorySnapshotWithDependencies,
    ),
  Layer.provideMerge(
    Layer.mergeAll(
      AntigravityInstallation.AntigravityInstallation.layer,
      CodexInstallation.CodexInstallation.layer,
    ),
  ),
);

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
  Layer.provideMerge(
    Layer.mergeAll(
      layerProviderEventLoggers,
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
      ResetCreditCoordinator.layer,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
    ),
  ),
  Layer.provideMerge(
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      CloudCliTokenManager.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ExternalLauncher.layer),
      ),
      layerCloudManagedEndpointRuntime,
    ),
  ),
);

const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerBackground),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsService.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
  Layer.provideMerge(DirectEndpoints.layer),
  Layer.provideMerge(RuntimeControl.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const layerSshWorkspace = SshWorkspaceSync.layer.pipe(
  Layer.provide(layerOrchestrationV2Runtime),
  Layer.provide(GitVcsDriver.layer),
  Layer.provide(RuntimeLayer.layerProjectService),
);

const layerNotes = NotesLayers.layer.pipe(
  Layer.provide(RuntimeLayer.layerEventSink),
  Layer.provide(
    HostThreadsMcpService.layer.pipe(
      Layer.provide(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
        ),
      ),
      Layer.provide(ThreadResultService.layer),
    ),
  ),
  Layer.provide(ThreadResultService.layer),
);

const layerMakeRoutes = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const autoUpdate = yield* ServerAutoUpdate.ServerAutoUpdate;
      yield* ServerActivation.forkParked(autoUpdate.run);
    }).pipe(Effect.provide(ServerAutoUpdate.layer)),
  ),
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(CloudHttp.layer),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(PullRequestHttp.layer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(WebhookRoute.layer.pipe(Layer.provide(RelayDeliveryProof.layer))),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    ServerHttp.layerRuntimeDrainRoute,
    ServerHttp.layerOtlpTracesProxyRoute,
    ServerHttp.layerAssetRoute,
    ServerHttp.layerAttachmentUploadRoute,
    DeviceHubProxy.layer,
    HubProxyHttp.layer,
    ServerBrowserStream.routeLayer,
    ServerHttp.layerStaticAndDevRoute,
    Ws.layer,
  ),
  Layer.mergeAll(
    McpHttpServer.layer.pipe(Layer.provide(Layer.mergeAll(layerFleetHealth, layerFleetPressure))),
    ComputerUseLeaseRoute.layer,
    layerMemoryToolkits,
    McpHttpServer.layerProviderToolkit,
    HandoffExpiry.layer,
    // Fleet goals act through the same launch, watch and dispatch services as these tools.
    McpHttpServer.layerFleetToolkit.pipe(
      Layer.provide(
        GoalLayers.layer.pipe(Layer.provide(HubDown.layer), Layer.provideMerge(layerFleetHealth)),
      ),
    ),
  ).pipe(
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
  ),
).pipe(
  // One instance for the goat_host_status tool and the server.getHostStatus RPC; fleet
  // placement reads the same one.
  Layer.provide(
    Layer.mergeAll(layerNotes, FleetPlacement.layer, FleetFallback.layerChains).pipe(
      Layer.provideMerge(
        McpHttpServer.layerHostStatusService.pipe(
          Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
        ),
      ),
    ),
  ),
  Layer.provide(CloudTaskSource.layer.pipe(Layer.provide(GitVcsDriver.layer))),
  Layer.provide(RemoteLaunchCatalog.layerWithoutDependencies),
  // One launch-watch store and one dispatch coordinator for the MCP tools, host
  // status, and the remote-launch catalog: they all follow runs and wake launchers.
  // The coordinator re-arms watches after a relayed send, so the store comes after it.
  Layer.provide(layerSshWorkspace),
  // SshHostSetup routes approvals of agent-requested provider syncs to ProviderHostSync.
  Layer.provide(
    SshDeviceAdd.layer.pipe(
      Layer.provideMerge(
        SshHostSetup.layer.pipe(
          Layer.provide(MaintenanceAudit.layer),
          Layer.provideMerge(
            ProviderHostSync.layer.pipe(
              Layer.provide(
                ProviderDiagnosisService.layer.pipe(Layer.provide(ProviderHostLive.layer)),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      HomeRequests.layer.pipe(Layer.provideMerge(CodexRoutes.layer)),
      ProviderOnboarding.layer,
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      ProviderDiagnosisRouting.layer,
      // Cloud launches read readiness from the provider × host matrix.
      CloudAgentService.layer.pipe(
        Layer.provide(ProviderHostSync.layer),
        Layer.provide(
          ThreadLaunchMcpService.layer.pipe(
            Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
            Layer.provide(CloudTaskSource.layer.pipe(Layer.provide(GitVcsDriver.layer))),
            Layer.provide(RemoteReportService.layer),
          ),
        ),
      ),
    ).pipe(
      Layer.provide(ProviderDiagnosisService.layer.pipe(Layer.provide(ProviderHostLive.layer))),
      Layer.provide(
        HostThreadsMcpService.layer.pipe(
          Layer.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
            ),
          ),
          Layer.provide(ThreadResultService.layer),
        ),
      ),
    ),
  ),
  Layer.provide(RemoteDispatchCoordinator.layer),
  Layer.provide(layerLaunchWatches),
  // One fleet goatclaw sync for the tools, host status and its scheduled reconcile.
  Layer.provide(GoatclawFleetSync.layer.pipe(Layer.provideMerge(SshRemoteDispatch.layer))),
  Layer.provide(
    PullRequestReviewGuideService.layer.pipe(Layer.provide(PullRequestReviewGuides.layer)),
  ),
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP.
  Layer.provide(layerPullRequestService),
  Layer.provide(ServerBrowser.layer.pipe(Layer.provide(DesktopBrowserChannel.layer))),
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(ConnectionCatalogBroker.layer),
  Layer.provide(
    ServerSelfUpdate.layer.pipe(
      Layer.provide(layerDesktopAppUpdate),
      Layer.provide(ProjectionStoreV2.layer),
      Layer.provide(RuntimeAdmission.layer),
    ),
  ),
  Layer.provide(layerCommandReadiness),
  Layer.provide(ServerHttp.layerBrowserApiCors),
  Layer.provide(ServerHttp.layerHttpCompression),
);

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per T3 home.
    const ownership = yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath);
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    // One slot for the whole server: every projection store reads through it, and the archive
    // service fills it once it has loaded which threads are archived.
    const layerArchiveGate = Layer.succeed(
      ThreadArchiveGate.ThreadArchiveGate,
      ThreadArchiveGate.makeThreadArchiveGateSlot(),
    );
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const cloudLinkParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const layerLauncher = ServiceLauncherClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            ServiceLauncherClient.ServiceLauncherPort,
            Effect.map(HttpServer.HttpServer, (server) =>
              typeof server.address === "string" || !("port" in server.address)
                ? undefined
                : server.address.port,
            ),
          ),
          Layer.effect(
            ServiceLauncherClient.ServiceLauncherHost,
            Effect.map(HttpServer.HttpServer, (server) =>
              typeof server.address !== "string" &&
              "hostname" in server.address &&
              typeof server.address.hostname === "string"
                ? server.address.hostname
                : undefined,
            ),
          ),
        ),
      ),
    );

    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
        yield* awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return;
        }

        const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
        const state = yield* makePersistedServerRuntimeState({
          config,
          instanceId: (yield* RuntimeIdentity.RuntimeIdentity).instanceId,
          port: address.port,
          serviceManaged: launcher.managed,
        });
        yield* ownership
          .publish(state)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
      }),
    );
    const layerTailscaleServe = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (typeof address === "string" || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: loopbackUrlHostForAddress(address),
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const cloudLinkStartup = desiredLinkReconcileStartup(cloudLinkParked);

    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          ...cloudLinkStartup.awaitParked,
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(layerRuntimeDependencies), Layer.provide(layerLauncher));

    const layerRoutes = HttpRouter.serve(layerMakeRoutes.pipe(Layer.provide(layerLauncher)), {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      withUntracedRequests,
      Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
    );
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerRuntimeState.pipe(Layer.provide(layerLauncher)),
      layerTailscaleServe,
      cloudLinkStartup.layer,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provide(CloudLink.layer.pipe(Layer.provideMerge(ConnectReachability.layer))),
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(McpSessionRegistry.layer.pipe(Layer.provide(layerServerEnvironment))),
      Layer.provide(layerActivation),
      Layer.provide(layerArchiveGate),
      Layer.provideMerge(RelayTracing.layerServerRelayBroker),
      Layer.provideMerge(layerHttpServer),
      Layer.provide(
        HttpRouter.layer.pipe(
          Layer.provide(Layer.succeed(HttpRouter.RouterConfig, HTTP_ROUTER_CONFIG)),
        ),
      ),
      Layer.provide(layerApplicationObservability),
      Layer.provide(HomeRoute.layer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provideMerge(AgentScopeLive.layer),
      Layer.provideMerge(layerPlatformServices),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(CodexRoutes.layerState));

// Keep the CLI boundary requirements explicit: cross-module inference widens this large
// composed layer to any when the memory/provider dependency graph is included.
export const runServer: Effect.Effect<
  never,
  Layer.Error<typeof layerMakeServer>,
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ServerConfig.ServerConfig
> = Layer.launch(layerMakeServer);

import * as RepositoryReferenceMcpService from "./RepositoryReferenceMcpService.ts";
import * as RepositoryLaunchMcpService from "./RepositoryLaunchMcpService.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import { DecisionToolkit } from "./toolkits/decision/tools.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { NoteToolkit } from "./toolkits/note/tools.ts";
import * as NotesService from "../notes/NotesService.ts";
import * as SshDeviceAdd from "../sshRemote/SshDeviceAdd.ts";
import * as Onboarding from "../provider/ProviderOnboarding.ts";
import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as ProviderDiagnosisRouting from "../provider/ProviderDiagnosisRouting.ts";
import * as ProviderHostSync from "../provider/ProviderHostSync.ts";
import * as CloudAgentService from "../cloudAgents/CloudAgentService.ts";
import { ProviderToolkit } from "./toolkits/provider/tools.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as FileSystem from "effect/FileSystem";
import * as ChannelGateway from "../channels/ChannelGateway.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import * as ChannelTaskExport from "../channels/ChannelTaskExport.ts";
import * as ChannelBotHome from "../channels/ChannelBotHome.ts";
import * as ChannelRemoteWorkers from "../channels/ChannelRemoteWorkers.ts";
import * as ChannelRuntime from "../channels/ChannelRuntime.ts";
import * as ChannelWorkerReports from "../channels/ChannelWorkerReports.ts";
import * as HubNodes from "../hubNodes/HubNodes.ts";
import * as ConnectionCatalogBroker from "../connections/ConnectionCatalogBroker.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as Path from "effect/Path";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import * as GoalService from "../fleet/goals/GoalService.ts";
import * as FleetFallback from "../fleet/resources/Fallback.ts";
import * as FleetPlacement from "../fleet/resources/Placement.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import * as MemorySettingsService from "../memory/MemorySettingsService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ThreadLaunchMcpService from "./ThreadLaunchMcpService.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as SshHostSetup from "../sshRemote/SshHostSetup.ts";
import * as SshWorkspaceSync from "../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as PendingQuestionsMcpService from "./PendingQuestionsMcpService.ts";
import * as ThreadSearchMcpService from "./ThreadSearchMcpService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { expect, it } from "@effect/vitest";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as McpHttpServer from "./McpHttpServer.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { ChannelToolkit } from "./toolkits/channel/tools.ts";
import { ConnectionToolkit } from "./toolkits/connection/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FleetToolkit } from "./toolkits/fleet/tools.ts";
import { FleetResourcesToolkit } from "./toolkits/fleet/resources/tools.ts";
import { HostStatusToolkit } from "./toolkits/hostStatus/tools.ts";
import { FleetHealthToolkit } from "./toolkits/fleet/healthTools.ts";
import * as HostHealthMonitor from "../fleet/health/HostHealthMonitor.ts";
import * as FleetHostStates from "../fleet/health/FleetHostStates.ts";
import * as Rescheduler from "../fleet/health/Rescheduler.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { MemoryToolkit } from "./toolkits/memory/tools.ts";
import { MemoryAdministrationToolkit } from "./toolkits/memoryAdministration/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { RemoteReportToolkit } from "./toolkits/remoteReport/tools.ts";
import { SshToolkit } from "./toolkits/ssh/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { ComputerUseToolkit } from "./toolkits/computerUse/tools.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";

const toolkits = {
  decision: DecisionToolkit,
  attachment: AttachmentToolkit,
  channel: ChannelToolkit,
  computerUse: ComputerUseToolkit,
  note: NoteToolkit,
  connection: ConnectionToolkit,
  device: DeviceToolkit,
  environment: EnvironmentToolkit,
  fleet: FleetToolkit,
  fleetResources: FleetResourcesToolkit,
  hostStatus: HostStatusToolkit,
  fleetHealth: FleetHealthToolkit,
  html: HtmlToolkit,
  memory: MemoryToolkit,
  memoryAdministration: MemoryAdministrationToolkit,
  orchestrator: OrchestratorToolkit,
  preview: PreviewToolkit,
  previewControls: PreviewControlsToolkit,
  project: ProjectToolkit,
  provider: ProviderToolkit,
  pullRequests: PullRequestsToolkit,
  remoteReport: RemoteReportToolkit,
  ssh: SshToolkit,
  thread: ThreadToolkit,
  worktree: WorktreeToolkit,
};
const entries = Object.values(agentSurfaceRegistry);
const { htmlRender, ...otherRegistrations } = McpHttpServer.catalogRegistrations;
const catalog = Layer.mergeAll(htmlRender, ...Object.values(otherRegistrations));

// Only registration and early argument refusal run. No domain handler may touch live state.
const unusedImport = () => Effect.die("Catalog registration must not import memory");
const dependencies = Layer.mergeAll(
  Layer.mock(DecisionInbox.DecisionInbox)({}),
  Layer.mock(Profiles.PermissionProfiles)({}),
  Layer.mock(NotesService.NotesService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(WorktreeInventoryService.WorktreeInventoryService)({}),
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ComputerUseLeases.ComputerUseLeases)({ proxy: undefined }),
  Layer.mock(Handoffs.Handoffs)({}),
  ServerConfig.layerTest("/tmp/agent-surface-catalog", "/tmp/agent-surface-catalog").pipe(
    Layer.provide(Path.layer),
    Layer.provide(FileSystem.layerNoop({ makeDirectory: () => Effect.void })),
  ),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  FileSystem.layerNoop({ makeDirectory: () => Effect.void }),
  Layer.mock(ChannelGateway.ChannelGateway)({}),
  Layer.mock(ChannelLedger.ChannelLedger)({}),
  Layer.mock(ChannelTaskExport.ChannelTaskExport)({}),
  Layer.mock(ChannelWorkerReports.ChannelWorkerReports)({}),
  Layer.mock(ChannelRemoteWorkers.ChannelRemoteWorkers)({}),
  Layer.mock(ChannelBotHome.ChannelBotHome)({}),
  Layer.mock(ChannelRuntime.ChannelRuntime)({ ownerToken: "test-owner" }),
  Layer.mock(ConnectionCatalogBroker.ConnectionCatalogBroker)({}),
  Layer.mock(HubNodes.HubNodes)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Path.layer,
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(Settings.ServerSettingsService)({}),
  Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
  Layer.mock(HostStatusMcpService.HostStatusMcpService)({}),
  Layer.mock(HubParity.HubParity)({}),
  Layer.mock(HubMembership.HubMembership)({}),
  Layer.mock(GoalService.GoalService)({}),
  Layer.mock(FleetFallback.FallbackChains)({}),
  Layer.mock(FleetPlacement.Placement)({}),
  Layer.mock(HtmlRender.HtmlRender)({}),
  Layer.mock(MemoryService.MemoryService)({
    importPorts: {
      readRegistration: unusedImport,
      saveRegistration: unusedImport,
      preflightBatch: unusedImport,
      readReceipt: unusedImport,
      readItem: unusedImport,
      findMatch: unusedImport,
      prepareTarget: unusedImport,
      binding: unusedImport,
      resolveProjectKey: unusedImport,
      commit: unusedImport,
    },
  }),
  Layer.mock(MemorySyncService.MemorySyncService)({}),
  Layer.mock(MemorySettingsService.MemorySettingsService)({}),
  Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderDiagnosisRouting.ProviderDiagnosisRouting)({}),
  Layer.mock(CloudAgentService.CloudAgentService)({}),
  Layer.mock(HomeRequests.CodexHomeRequests)({}),
  Layer.mock(ProviderHostSync.ProviderHostSync)({}),
  Layer.mock(Onboarding.ProviderOnboarding)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/tmp/agent-surface-catalog",
  }),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchMcpService.ThreadLaunchMcpService)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(RemoteReportService.RemoteReportService)({}),
  Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
  Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
  Layer.mock(HostHealthMonitor.HostHealthMonitor)({}),
  Layer.mock(FleetHostStates.FleetHostStates)({}),
  Layer.mock(Rescheduler.Rescheduler)({}),
  Layer.mock(SshHostSetup.SshHostSetup)({}),
  Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
  Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
  Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
  Layer.mock(LaunchWatchService.LaunchWatchService)({}),
  Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
  Layer.mock(PendingQuestionsMcpService.PendingQuestionsMcpService)({}),
  Layer.mock(ThreadSearchMcpService.ThreadSearchMcpService)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(ThreadResultService.ThreadResultService)({}),
  Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
  Layer.mock(CloudMachineService.CloudMachineService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  NodeCrypto.layer,
);
const registered = catalog.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(McpServer.McpServer.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "registry-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "registry-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it("gives every entry a unique path, legacy name and resolvable schema reference", () => {
  expect(entries).toHaveLength(190); // Includes current memory, browser, provider, SSH runtime, GOAT Bot home, fleet goal, resource and health, notes, hub parity and membership, permission profile, computer use, decision, and thread checkpoint and recovery tools.
  expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);
  for (const [path, entry] of Object.entries(agentSurfaceRegistry)) {
    expect(path).toBe(entry.path);
    expect(path).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
    expect(entry.legacyNames).toContain(entry.name);
    const tools: Record<string, Tool.Any> = toolkits[entry.schemaRefs.toolkit].tools;
    const tool = tools[entry.schemaRefs.tool];
    expect(tool, path).toBeDefined();
    expect(Tool.getJsonSchema(tool!)).toMatchObject({ type: "object" });
    expect(tool!.successSchema).toBeDefined();
    expect(tool!.failureSchema).toBeDefined();
    expect(Tool.getDescription(tool!)).toBe(entry.description);
  }
});

it("preserves the memory injection guidance in registry and published descriptions", () => {
  const descriptions = {
    memory_search:
      "Search memory (default scope: user). fts is phrase search; use mode substring for partial text. Pass nextCursor unchanged with the same query and scope, even when items is empty. If indexCoverage is partial/unavailable, do not conclude a memory is absent.",
    memory_upsert:
      "Create or update memory with an explicit memory:write grant. Read-only sessions cannot write. Keep one current assertion per item; correct an existing memory by updating it, not creating another. Do not store progress reports, tool output, or execution summaries.",
  };
  expect(agentSurfaceRegistry["memory.search"].description).toBe(descriptions.memory_search);
  expect(agentSurfaceRegistry["memory.upsert"].description).toBe(descriptions.memory_upsert);
  expect(Tool.getDescription(MemoryToolkit.tools.memory_search)).toBe(descriptions.memory_search);
  expect(Tool.getDescription(MemoryToolkit.tools.memory_upsert)).toBe(descriptions.memory_upsert);
});

it.effect(
  "assembles exactly the registry, with effect hints from each real handler declaration",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual(
        entries.map((entry) => entry.name).sort(),
      );
      for (const entry of entries) {
        const tool = server.tools.find(({ tool }) => tool.name === entry.name)!.tool;
        expect(tool.annotations, entry.path).toMatchObject({
          readOnlyHint: entry.effect === "read",
          destructiveHint: entry.effect === "destructive",
        });
      }
      // Audit mismatches: hints follow the current gates, including task_status's write gate.
      const hints = (name: string) =>
        server.tools.find(({ tool }) => tool.name === name)!.tool.annotations;
      expect(hints("goat_ssh_browse")?.readOnlyHint).toBe(false);
      expect(hints("goat_thread_read")?.readOnlyHint).toBe(true);
      expect(hints("preview_snapshot")?.readOnlyHint).toBe(true);
      expect(hints("task_status")?.readOnlyHint).toBe(false);
      expect(hints("goat_review_findings_record")?.readOnlyHint).toBe(false);
      expect(hints("goat_review_findings_export")?.readOnlyHint).toBe(true);
      expect(hints("goat_worktree_cleanup")?.destructiveHint).toBe(true);
    }).pipe(Effect.provide(registered)),
);

it.effect("publishes closed top-level schemas and refuses unknown keys for the whole catalog", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const { tool } of server.tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      const result = yield* server
        .callTool({ name: tool.name, arguments: { misspelledHost: "box" } })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.isError, tool.name).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type === "text")
        expect(JSON.parse(content.text)).toMatchObject({ code: "invalid_request" });
    }
  }).pipe(Effect.provide(registered)),
);

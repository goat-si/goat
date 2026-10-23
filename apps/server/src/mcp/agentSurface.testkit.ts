import * as RepositoryReferenceMcpService from "./RepositoryReferenceMcpService.ts";
import * as RepositoryLaunchMcpService from "./RepositoryLaunchMcpService.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import { DecisionToolkit } from "./toolkits/decision/tools.ts";
import { AgentSurfaceToolkit } from "./toolkits/agentSurface/tools.ts";
import { NoteToolkit } from "./toolkits/note/tools.ts";
import * as NotesService from "../notes/NotesService.ts";
import * as SshDeviceAdd from "../sshRemote/SshDeviceAdd.ts";
import * as Onboarding from "../provider/ProviderOnboarding.ts";
import * as ProviderSettingsService from "../provider/ProviderSettings.ts";
import * as HomeRequests from "../provider/CodexHomeRequests.ts";
import * as ProviderDiagnosisRouting from "../provider/ProviderDiagnosisRouting.ts";
import * as ProviderHostSync from "../provider/ProviderHostSync.ts";
import * as CloudAgentService from "../cloudAgents/CloudAgentService.ts";
import { ProviderToolkit } from "./toolkits/provider/tools.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
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
import { layerPermissionProfilesOff, liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema } from "effect/ai";
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
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

// The assembled /mcp catalog over inert services: registration and early refusals run, domain
// handlers do not touch live state.
export const toolkits = {
  agentSurface: AgentSurfaceToolkit,
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
export const entries = Object.values(agentSurfaceRegistry);
const { htmlRender, ...otherRegistrations } = McpHttpServer.catalogRegistrations;
export const catalog = Layer.mergeAll(htmlRender, ...Object.values(otherRegistrations));

// Only registration and early argument refusal run. No domain handler may touch live state.
const unusedImport = () => Effect.die("Catalog registration must not import memory");
export const dependencies = Layer.mergeAll(
  Layer.mock(DecisionInbox.DecisionInbox)({}),
  // goatclaw off: the capability gate admits every call, so handlers decide access.
  layerPermissionProfilesOff,
  Layer.mock(NotesService.NotesService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(WorktreeInventoryService.WorktreeInventoryService)({}),
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({}),
  // A live thread, so thread callers reach the handler instead of the inert services above.
  liveThreadsLayer,
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
  Layer.mock(ProviderSettingsService.ProviderSettings)({
    presentDiagnosis: (result) => Effect.succeed(result),
  }),
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
export const client = McpSchema.McpServerClient.of({
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

const jsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(jsonText);
const encodeJson = Schema.encodeSync(jsonText);
const decodeCallToolResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
type RpcMessage = {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
};

/**
 * The catalog served over /mcp the way agents reach it: each caller sends its own bearer token
 * and the auth middleware provides that caller's scope. Needs an HTTP server and client, such as
 * NodeHttpServer.layerTest, and a scope that keeps the server up.
 */
export const serveCatalogOverHttp = Effect.fn("agentSurfaceTestkit.serveCatalogOverHttp")(
  function* (scopes: Readonly<Record<string, McpInvocationScope>>) {
    const scopeOf = new Map(
      Object.entries(scopes).map(([caller, scope]) => [`Bearer ${caller}.token`, scope]),
    );
    yield* HttpRouter.serve(
      catalog.pipe(
        Layer.provide(dependencies),
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
            explainRefusal: () => Effect.succeed({ reason: "unknown" as const }),
            isRegistryToken: () => false,
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(scopeOf.get(request.headers.authorization ?? "")),
          }),
        ),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.build);
    const http = yield* HttpClient.HttpClient;
    const sessions = new Map<string, string>();
    let nextId = 0;
    const post = Effect.fn(function* (caller: string, method: string, params: object) {
      const id = ++nextId;
      const session = sessions.get(caller);
      const response = yield* http.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${caller}.token`,
          ...(session === undefined
            ? {}
            : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
        },
        body: HttpBody.text(encodeJson({ jsonrpc: "2.0", id, method, params }), "application/json"),
      });
      const sessionId = response.headers["mcp-session-id"];
      if (session === undefined && sessionId !== undefined) sessions.set(caller, sessionId);
      const text = yield* response.text;
      const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      const messages = (lines.length > 0 ? lines.map((line) => line.slice(5)) : [text]).map(
        (line) => decodeJson(line) as RpcMessage,
      );
      return messages.find((message) => message.id === id) ?? { error: text };
    });
    const ensureSession = (caller: string) =>
      sessions.has(caller)
        ? Effect.void
        : post(caller, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "agent-surface-http", version: "1" },
          });
    return {
      /** tools/call as the caller; a JSON-RPC error comes back as an error result naming it. */
      callTool: (caller: string, name: string, args: object) =>
        ensureSession(caller).pipe(
          Effect.andThen(post(caller, "tools/call", { name, arguments: args })),
          // A transport failure is a broken harness, never an access outcome.
          Effect.orDie,
          Effect.map((message) =>
            message.result === undefined
              ? new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: "text", text: `rpc error: ${encodeJson(message.error)}` }],
                })
              : decodeCallToolResult(message.result),
          ),
        ),
      /** Every tool name tools/list shows the caller, across pages. */
      listToolNames: Effect.fn(function* (caller: string) {
        yield* ensureSession(caller);
        const names: Array<string> = [];
        let cursor: unknown;
        do {
          const page = (yield* post(caller, "tools/list", cursor === undefined ? {} : { cursor }))
            .result as { tools: ReadonlyArray<{ name: string }>; nextCursor?: unknown };
          names.push(...page.tools.map((tool) => tool.name));
          cursor = page.nextCursor;
        } while (cursor !== undefined && cursor !== null);
        return names;
      }),
    };
  },
);

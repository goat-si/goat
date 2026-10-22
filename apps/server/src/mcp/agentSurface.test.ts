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
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, HandoffSummary, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";
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
  expect(entries).toHaveLength(191); // Includes current memory, browser, provider, SSH runtime, GOAT Bot home, fleet goal, resource and health, notes, hub, permission profile and goatclaw sync, computer use, decision, and lane tools.
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

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];
const registeredNames = new Set<string>(entries.map((entry) => entry.name));
const toolOf = (entry: Entry): Tool.Any =>
  (toolkits[entry.schemaRefs.toolkit].tools as Record<string, Tool.Any>)[entry.schemaRefs.tool]!;

type JsonSchema = { readonly [key: string]: unknown };
const isObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const children = (node: unknown): ReadonlyArray<unknown> =>
  Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
const refsIn = (node: unknown): ReadonlyArray<string> => [
  ...(isObject(node) && typeof node["$ref"] === "string" ? [node["$ref"]] : []),
  ...children(node).flatMap(refsIn),
];
const definitionName = (ref: string) => /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
const unresolvedRefs = (root: unknown, definitions: JsonSchema) =>
  [...refsIn(root), ...refsIn(definitions)].filter((ref) => {
    const name = definitionName(ref);
    return name === undefined || !(name in definitions);
  });
const resolve = (node: unknown, definitions: JsonSchema): unknown => {
  const name =
    isObject(node) && typeof node["$ref"] === "string" ? definitionName(node["$ref"]) : undefined;
  return name === undefined ? node : resolve(definitions[name], definitions);
};
const literals = (node: unknown): ReadonlyArray<unknown> =>
  !isObject(node)
    ? []
    : "const" in node
      ? [node["const"]]
      : Array.isArray(node["enum"])
        ? node["enum"]
        : [];
const propertiesOf = (node: unknown, definitions: JsonSchema): JsonSchema => {
  const resolved = resolve(node, definitions);
  return isObject(resolved) && isObject(resolved["properties"]) ? resolved["properties"] : {};
};
/** Every object schema reachable from a result schema whose kind is the literal needs_human. */
const needsHumanArms = (document: { schema: unknown; definitions: JsonSchema }) => {
  const arms: Array<JsonSchema> = [];
  const visit = (node: unknown) => {
    if (isObject(node) && isObject(node["properties"])) {
      const kind = literals(resolve(node["properties"]["kind"], document.definitions));
      if (kind.length === 1 && kind[0] === "needs_human") arms.push(node);
    }
    for (const child of children(node)) visit(child);
  };
  visit(document.schema);
  visit(document.definitions);
  return arms;
};
const resultDocument = (entry: Entry) => {
  const document = Schema.toJsonSchemaDocument(toolOf(entry).successSchema);
  return { schema: document.schema, definitions: document.definitions as JsonSchema };
};

describe("agent surface schemas", () => {
  it("renders every input, success and failure schema as self-contained JSON Schema", () => {
    for (const entry of entries) {
      const tool = toolOf(entry);
      const input = Tool.getJsonSchema(tool) as JsonSchema;
      const inputDefinitions = isObject(input["$defs"]) ? input["$defs"] : {};
      expect(unresolvedRefs(input, inputDefinitions), `${entry.path} input`).toEqual([]);
      for (const [slot, schema] of [
        ["success", tool.successSchema],
        ["failure", tool.failureSchema],
      ] as const) {
        const document = Schema.toJsonSchemaDocument(schema);
        expect(
          unresolvedRefs(document.schema, document.definitions as JsonSchema),
          `${entry.path} ${slot}`,
        ).toEqual([]);
      }
    }
  });
});

// quarantine: #782 computer_use.request returns needs_human without next, so agents cannot tell what to call after approval.
const NEEDS_HUMAN_WITHOUT_NEXT = new Set(["computer_use.request"]);
// quarantine: #782 hub devices ask through the decision inbox: state needs_human with a decisionId, no handoff.
const DECISION_INBOX_NEEDS_HUMAN = new Set([
  "hub.device_join",
  "hub.device_leave",
  "hub.device_repair",
]);
// quarantine: #782 these share a result union with their siblings, so their schema offers a needs_human they never return.
const SHARED_RESULT_NEEDS_HUMAN = new Set([
  "ssh.host_forget",
  "ssh.host_status",
  "provider.login_status",
  "provider.login_cancel",
]);

describe("agent surface needs_human results", () => {
  it("hands work to a person only through the shared handoff summary and a registered next call", () => {
    const summaryKeys = Object.keys(HandoffSummary.fields).sort();
    const problems: Array<string> = [];
    for (const entry of entries) {
      const document = resultDocument(entry);
      for (const arm of needsHumanArms(document)) {
        if (entry.humanSteps.length === 0 && !SHARED_RESULT_NEEDS_HUMAN.has(entry.path))
          problems.push(`${entry.path}: no humanSteps`);
        const required = Array.isArray(arm["required"]) ? arm["required"] : [];
        if (!required.includes("handoff")) problems.push(`${entry.path}: handoff not required`);
        const properties = arm["properties"] as JsonSchema;
        const handoffKeys = Object.keys(
          propertiesOf(properties["handoff"], document.definitions),
        ).sort();
        if (handoffKeys.join() !== summaryKeys.join())
          problems.push(`${entry.path}: handoff fields ${handoffKeys.join(",")}`);
        if (NEEDS_HUMAN_WITHOUT_NEXT.has(entry.path)) continue;
        const next = propertiesOf(properties["next"], document.definitions);
        const calls = literals(resolve(next["call"], document.definitions));
        if (calls.length === 0) problems.push(`${entry.path}: no next.call`);
        for (const call of calls)
          if (!registeredNames.has(String(call)))
            problems.push(`${entry.path}: next.call ${String(call)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("returns a handoff from every tool that documents needs_human", () => {
    const missing = entries.filter(
      (entry) =>
        entry.description.includes("needs_human") &&
        !DECISION_INBOX_NEEDS_HUMAN.has(entry.path) &&
        needsHumanArms(resultDocument(entry)).length === 0,
    );
    expect(missing.map((entry) => entry.path)).toEqual([]);
  });
});

// Callers the access layer distinguishes (McpToolAccess.ts, McpInvocationContext.ts).
const scopeBase = {
  environmentId: EnvironmentId.make("environment:conformance"),
  requestNamespace: "conformance",
  issuedAt: 0,
  capabilities: new Set([
    "memory",
    "preview",
    "orchestration",
    "worktree",
    "device",
    "pull-requests",
  ] as const),
  grantedScopes: [],
};
const callers = {
  thread: {
    ...scopeBase,
    thread: {
      threadId: ThreadId.make("thread:conformance"),
      providerSessionId: "session:conformance",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  readOnlyClient: {
    ...scopeBase,
    readOnly: true,
    thread: undefined,
    client: { sessionId: "client:read-only", label: "read-only", access: "read-only" },
  },
  fullClient: {
    ...scopeBase,
    thread: undefined,
    client: { sessionId: "client:full", label: "full", access: "full-access" },
  },
} satisfies Record<string, McpInvocationScope>;
type Caller = keyof typeof callers;
const TARGET_THREAD = "thread:conformance-target";

/** reached: the access layer let the call into its handler, which then met inert services. */
type Outcome = "thread_required" | "read_only" | "denied" | "reached";
const classify = (result: McpSchema.CallToolResult): Outcome => {
  const content = result.content[0];
  const text = content?.type === "text" ? content.text : "";
  if (!result.isError) return "reached";
  if (/thread_credential_required|acts as the calling GOAT thread/.test(text))
    return "thread_required";
  // Some toolkits (pull requests, images) return the refusal message without its code.
  if (/approved for read-only access/.test(text)) return "read_only";
  if (/"code":"capability_denied"/.test(text)) return "denied";
  return "reached";
};

// Inputs the schema sampler cannot satisfy, and reads that reach other machines with this
// machine's SSH keys unless asked for the local answer.
const FIXTURE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  "note.read": { path: "inbox/note.md" },
  "note.write": { path: "inbox/note.md", body: "- [ ] item", status: null, baseRevision: null },
  "note.move": { from: "inbox/note.md", to: "done/note.md", baseRevision: "0".repeat(64) },
  "channel.task_export": { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
  "scheduler.status": { local: false },
  "pending_request.list": { scope: "launched", hosts: ["box"] },
  "provider.host_matrix": { localOnly: false },
  "host.status": { local: null },
};

const REASONS = {
  serviceThreadCheck: "Requires a thread inside its service, after the access layer.",
  imageTool: "Image tools report refusals as text without a code (McpHttpServer.ts image path).",
  sshFanOut:
    "Reaches other machines with this machine's SSH keys, which read-only clients may not use.",
  dryRunDefault: "Defaults to a dry run, which reads.",
  clientOnly: "Only another GOAT's dispatch session may call it.",
  grantChecked: "Checks a scope the test client does not hold, inside its handler.",
} as const;
// Where the runtime outcome differs from what requires and effect alone predict, and why.
// The service checks, SSH refusal wording and codeless refusals are tracked in #791.
const ACCESS_EXCEPTIONS: Readonly<
  Record<string, { readonly reason: keyof typeof REASONS } & Partial<Record<Caller, Outcome>>>
> = {
  "goal.apply": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.pause": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.resume": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.delete": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "provider.home_request": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "provider.setup_open": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "device.screenshot": { reason: "imageTool", readOnlyClient: "reached", fullClient: "reached" },
  "preview.snapshot": { reason: "imageTool", readOnlyClient: "reached", fullClient: "reached" },
  "scheduler.status": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "pending_request.list": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "provider.host_matrix": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "hub.device_verify": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "host.status": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "cloud_agent.holders": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "worktree.cleanup": { reason: "dryRunDefault", readOnlyClient: "reached" },
  "permission_profile.sync": { reason: "clientOnly", thread: "denied", fullClient: "denied" },
  "channel.task_move": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.create": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.stop": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.resume": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
};

const expectedOutcome = (entry: Entry, caller: Caller): Outcome => {
  const exception = ACCESS_EXCEPTIONS[entry.path]?.[caller];
  if (exception !== undefined) return exception;
  if (caller === "thread") return entry.requires === "client" ? "denied" : "reached";
  if (entry.requires === "thread") return "thread_required";
  if (caller === "readOnlyClient" && entry.effect !== "read") return "read_only";
  return "reached";
};

// One decodable input per entry: sampled from the tool's own schema with a seed from its path,
// then encoded through the JSON codec production decodes with (McpHttpServer decodeAsAdvertised).
const argumentsFor = Effect.fn(function* (entry: Entry) {
  const fixture = FIXTURE_ARGS[entry.path];
  if (fixture !== undefined) return fixture;
  const tool = toolOf(entry);
  // A schema the sampler cannot derive needs an entry in FIXTURE_ARGS.
  const [sample] = yield* Arbitrary.sampleEffect(Arbitrary.schema(tool.parametersSchema), {
    count: 1,
    seed: entry.path,
  });
  // Tool.Any erases the codec's services; tool parameter schemas need none.
  const codec = Schema.toCodecJson(tool.parametersSchema) as unknown as Schema.Codec<unknown>;
  const sampled = yield* Schema.encodeUnknownEffect(codec)(sample);
  const encoded: Record<string, unknown> = isObject(sampled) ? sampled : {};
  // Routing to another host has its own tests; this matrix asks about the local call.
  const required = (Tool.getJsonSchema(tool) as JsonSchema)["required"];
  const hostRequired = Array.isArray(required) && required.includes("host");
  return {
    ...encoded,
    ...(entry.hostRoutable && "host" in encoded && !hostRequired ? { host: null } : {}),
    // Outside clients name their target thread; without one they stop at target resolution.
    ...("threadId" in encoded && encoded["threadId"] === null ? { threadId: TARGET_THREAD } : {}),
  };
});

const via = {
  direct: (name: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    ),
};

describe("agent surface access", () => {
  it.effect("refuses each caller exactly where the registry's requires and effect say", () =>
    Effect.gen(function* () {
      const mismatches: Array<string> = [];
      for (const entry of entries) {
        // Memory access is a per-task grant its handlers check; toolkits/memory tests own it.
        if (entry.resource === "memory") continue;
        const args = yield* argumentsFor(entry);
        for (const caller of Object.keys(callers) as ReadonlyArray<Caller>) {
          for (const [route, call] of Object.entries(via)) {
            const result = yield* call(entry.name, args).pipe(
              Effect.provideService(McpInvocationContext, callers[caller]),
              Effect.provideService(McpSchema.McpServerClient, client),
              // An inert service dies; the access layer already ran.
              Effect.catchDefect(() =>
                Effect.succeed(new McpSchema.CallToolResult({ isError: true, content: [] })),
              ),
            );
            const outcome = classify(result);
            const expected = expectedOutcome(entry, caller);
            if (outcome !== expected) {
              const content = result.content[0];
              const detail = content?.type === "text" ? content.text.slice(0, 160) : "";
              mismatches.push(
                `${entry.path} ${caller} ${route}: expected ${expected}, got ${outcome} (${detail})`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    }).pipe(Effect.provide(registered)),
  );

  it("documents every access exception", () => {
    for (const [path, exception] of Object.entries(ACCESS_EXCEPTIONS)) {
      expect(registeredNames, path).toContain(
        agentSurfaceRegistry[path as keyof typeof agentSurfaceRegistry]?.name,
      );
      expect(REASONS[exception.reason], path).toBeDefined();
    }
  });

  // quarantine: #778 goat_call is not on dev yet; add it to via when rollout 4 lands.
  it.todo("gives goat_call the same outcome as a direct call for every entry and caller");
  // quarantine: #778 goat_eval is not on dev yet; add a one-call program to via when rollout 10 lands.
  it.todo(
    "gives a goat_eval call step the same outcome as a direct call for every entry and caller",
  );
});

import { layerNoFleetSync } from "../../goatclaw/FleetSync.testkit.ts";
import * as RepositoryReferenceMcpService from "../RepositoryReferenceMcpService.ts";
import * as RepositoryLaunchMcpService from "../RepositoryLaunchMcpService.ts";
import * as ThreadReplicaService from "../ThreadReplicaService.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as PermissionSettings from "../../serverSettings.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatImageAttachment,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import {
  resolveGoatMcpToolDefinition,
  resolveGoatMcpToolPresentation,
} from "@goat/shared/goatMcpToolPresentation";
import { htmlRenderFromToolItem } from "@goat/shared/toolOutput";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorQuestionAlreadyAnsweredError,
} from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SshDeviceAdd from "../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as SshWorkspaceSync from "../../sshRemote/SshWorkspaceSync.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as ThreadResultService from "../../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { newLaunchWatch } from "../launchWatch.ts";
import * as LaunchWatchService from "../LaunchWatchService.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { dispatchFailure } from "../threadAccess.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import { McpAttachmentInput } from "./attachment/input.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { ChannelToolkit } from "./channel/tools.ts";
import { ConnectionToolkit } from "./connection/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { FleetHealthToolkit } from "./fleet/healthTools.ts";
import { FleetResourcesToolkit } from "./fleet/resources/tools.ts";
import { FleetToolkit } from "./fleet/tools.ts";
import { HostStatusToolkit } from "./hostStatus/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { ProviderToolkit } from "./provider/tools.ts";
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { RemoteReportToolkit } from "./remoteReport/tools.ts";
import * as SshHandlers from "./ssh/handlers.ts";
import { SshToolkit } from "./ssh/tools.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

// A service provided here shadows a test's own mock, so tests that stub the
// provider registry start from this layer.
const layerThreadToolkitWithoutProviders = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
  Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
  Layer.provide(
    Layer.mock(LaunchWatchService.LaunchWatchService)({ find: () => Effect.succeed(null) }).pipe(
      Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
    ),
  ),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ connectedHosts: Effect.succeed([]) }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
);
const layerThreadToolkit = layerThreadToolkitWithoutProviders.pipe(
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
);

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    EnvironmentToolkit,
    HostStatusToolkit,
    FleetHealthToolkit,
    FleetToolkit,
    FleetResourcesToolkit,
    ProviderToolkit,
    PreviewControlsToolkit,
    DeviceToolkit,
    PullRequestsToolkit,
    HtmlToolkit,
    SshToolkit,
    ConnectionToolkit,
    RemoteReportToolkit,
    ChannelToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      const definition = resolveGoatMcpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveGoatMcpToolPresentation(name)?.logo, name).toBe("t3-code");
        expect(resolveGoatMcpToolDefinition(name)?.summaryAction ?? null, name).not.toBeNull();
      }
    }
  }
  // Public catalog contract: exactly the renamed tools, with no callable legacy aliases.
  expect([...names].filter((name) => name.startsWith("goat_")).sort()).toEqual([
    "goat_attachment_discard",
    "goat_attachment_prepare_upload",
    "goat_cloud_holders",
    "goat_cloud_launch",
    "goat_cloud_machine_create",
    "goat_cloud_machine_list",
    "goat_cloud_machine_resume",
    "goat_cloud_machine_stop",
    "goat_cloud_run_forget",
    "goat_cloud_run_list",
    "goat_cloud_run_register",
    "goat_connection_add_ssh",
    "goat_connection_list",
    "goat_connection_remove",
    "goat_environment_preferences_update",
    "goat_environment_read",
    "goat_fallback_chain_get",
    "goat_fallback_chain_set",
    "goat_goal_apply",
    "goat_goal_delete",
    "goat_goal_get",
    "goat_goal_list",
    "goat_goal_pause",
    "goat_goal_resume",
    "goat_goatclaw_sync",
    "goat_host_cordon",
    "goat_host_drain",
    "goat_host_link_create",
    "goat_host_link_list",
    "goat_host_link_remove",
    "goat_host_status",
    "goat_host_uncordon",
    "goat_hub_device_join",
    "goat_hub_device_leave",
    "goat_hub_device_repair",
    "goat_hub_device_verify",
    "goat_origin_report",
    "goat_origin_reports_wait",
    "goat_pending_request_list",
    "goat_pending_request_read",
    "goat_pending_request_respond",
    "goat_permission_profile_get",
    "goat_preview_close",
    "goat_preview_list",
    "goat_project_clone",
    "goat_project_create",
    "goat_project_delete",
    "goat_project_list",
    "goat_project_read",
    "goat_project_update",
    "goat_provider_add",
    "goat_provider_addable_list",
    "goat_provider_diagnose",
    "goat_provider_home_request",
    "goat_provider_host_matrix",
    "goat_provider_link",
    "goat_provider_login_cancel",
    "goat_provider_login_start",
    "goat_provider_login_status",
    "goat_provider_remove",
    "goat_provider_setup_open",
    "goat_provider_sync",
    "goat_provider_sync_cancel",
    "goat_provider_sync_status",
    "goat_provider_update",
    "goat_queue_cancel",
    "goat_queue_edit",
    "goat_queue_list",
    "goat_queue_promote_to_steer",
    "goat_queue_read",
    "goat_queue_reorder",
    "goat_repository_snapshot",
    "goat_review_findings_export",
    "goat_review_findings_record",
    "goat_scheduler_status",
    "goat_ssh_browse",
    "goat_ssh_host_add",
    "goat_ssh_host_forget",
    "goat_ssh_host_list",
    "goat_ssh_host_prepare",
    "goat_ssh_host_status",
    "goat_ssh_reports",
    "goat_ssh_runtime_update",
    "goat_ssh_thread_handoff",
    "goat_ssh_thread_launch",
    "goat_thread_checkpoint_capture",
    "goat_thread_checkpoint_reconcile",
    "goat_thread_checkpoint_restore",
    "goat_thread_configuration",
    "goat_thread_configure",
    "goat_thread_fork",
    "goat_thread_handoff_host",
    "goat_thread_interrupt",
    "goat_thread_launch",
    "goat_thread_list",
    "goat_thread_merge_back",
    "goat_thread_organize",
    "goat_thread_read",
    "goat_thread_replication_set",
    "goat_thread_report_result",
    "goat_thread_reschedule",
    "goat_thread_retry",
    "goat_thread_search",
    "goat_thread_send",
    "goat_thread_send_attachments",
    "goat_thread_status",
    "goat_thread_transfers",
    "goat_thread_unwatch",
    "goat_thread_update",
    "goat_thread_wait",
    "goat_thread_watch",
    "goat_thread_watch_list",
    "goat_workflow_stop",
    "goat_worktree_cleanup",
    "goat_worktree_handoff",
    "goat_worktree_inventory",
    "goat_worktree_list",
    "goat_worktree_remove",
    "goat_worktree_status",
  ]);
  expect([...names].filter((name) => name.startsWith("channel_")).sort()).toEqual([
    "channel_bot_home",
    "channel_bot_home_claim",
    "channel_ingest",
    "channel_input_get",
    "channel_task_export",
    "channel_task_get",
    "channel_task_list",
    "channel_task_move",
    "channel_task_report",
  ]);
  expect(names.size).toBe(175);
  expect([...names].some((name) => name.startsWith("t3_"))).toBe(false);
  expect(names.has("goat_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
  for (const [tool, questionDelivery] of [
    [ProjectToolkit.tools.goat_thread_launch, "Only local user-input questions still arrive."],
    [
      SshToolkit.tools.goat_ssh_thread_launch,
      "None of this remote thread's questions arrive through the launch watch after opting out.",
    ],
  ] as const) {
    const schema = Tool.getJsonSchema(tool);
    expect(schema).toMatchObject({
      properties: {
        notifyOnCompletion: {
          anyOf: expect.arrayContaining([
            {
              type: "boolean",
              description: expect.stringContaining(
                `${questionDelivery} SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting.`,
              ),
            },
          ]),
        },
      },
    });
  }
});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "goat_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "goat_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<never>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
      ),
    ),
  ),
);

it("bounds public command rejections and redacts internal dispatch causes", () => {
  const command = { commandId: CommandId.make("mcp-core-command"), commandType: "thread.settle" };
  expect(
    dispatchFailure(new OrchestratorDispatchError({ ...command, cause: "🙂".repeat(1001) }))
      .message,
  ).toBe("🙂".repeat(1000));
  expect(
    dispatchFailure(
      new OrchestratorCommandRejectedError({ ...command, cause: "Run is not queued." }),
    ).message,
  ).toBe("Run is not queued.");
  for (const cause of [
    undefined,
    "",
    new Error("private-storage-path"),
    { message: "private-storage-path" },
  ]) {
    expect(dispatchFailure(new OrchestratorDispatchError({ ...command, cause }))).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(
      dispatchFailure(new OrchestratorCommandRejectedError({ ...command, cause })),
    ).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }
  expect(
    dispatchFailure(new OrchestratorProjectionError({ threadId, cause: "private-storage-path" })),
  ).toMatchObject({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });
});

it.effect("returns an HTML render reference that Codex and Claude tool rows both carry", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "goat_html_render",
        arguments: { html: "<p>Revenue</p>", title: "Revenue", height: 240 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const reference = htmlRenderFromToolItem({
      toolName: "t3-code.html_render",
      output: result.structuredContent,
    });
    expect(reference).toMatchObject({ title: "Revenue", height: 240 });
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: result.content }),
    ).toEqual(reference);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerHtmlToolkit.pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-html-render-" })),
        Layer.provide(NodeServices.layer),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                deletedAt: null,
                archivedAt: null,
                activeRunId: RunId.make("mcp-core-run"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              } as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    ),
  ),
);

it.effect("refuses an undeclared argument before the tool runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    // Every service here is an empty mock, so a tool that ran would fail differently.
    const result = yield* server
      .callTool({ name: "goat_thread_search", arguments: { query: "release", hostId: "box" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
      message:
        "goat_thread_search does not take hostId, so nothing ran. It takes query, limit, projectId, allProjects, host, hosts, allHosts, statuses, updatedAfter, updatedBefore, includeArchived, cursor.",
    });
    const definition = server.tools.find(({ tool }) => tool.name === "goat_thread_search");
    expect(definition?.tool.inputSchema.additionalProperties).toBe(false);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect("keeps unexpected handler defects private through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "goat_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Tool execution failed due to an internal server error." },
    ]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.die(new Error("private-storage-path")),
          }),
        ),
      ),
    ),
  ),
);

it.effect("records the calling agent and the agent a tool acted on", () => {
  // Recording runs detached from the tool response, so each expected event is awaited.
  const recorded = [
    Deferred.makeUnsafe<{ event: string; properties: object }>(),
    Deferred.makeUnsafe<{ event: string; properties: object }>(),
  ];
  let recordedCount = 0;
  const shell = (id: ThreadId, instanceId: string, model: string) =>
    ({
      id,
      projectId: "mcp-core-project",
      providerInstanceId: ProviderInstanceId.make(instanceId),
      modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
      runtimeMode: "full-access",
      interactionMode: "default",
      archivedAt: null,
      deletedAt: null,
      activeRunId: "mcp-core-run",
      createdBy: "agent",
      creationSource: "mcp",
      lineage: {
        parentThreadId: id === threadId ? ThreadId.make("mcp-core-parent") : null,
        relationshipToParent: id === threadId ? "subagent" : null,
        rootThreadId: ThreadId.make("mcp-core-parent"),
      },
    }) as never;
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server
      .callTool({ name: "goat_thread_fork", arguments: { sourcePoint: { type: "latest_stable" } } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const { event, properties } = yield* Deferred.await(recorded[0]!);
    expect(event).toBe("mcp.tool.invoked");
    expect(properties).toMatchObject({
      tool: "goat_thread_fork",
      outcome: "ok",
      callerProvider: "codex",
      callerModel: "gpt-5.5",
      callerOrigin: "agent",
      callerDepth: 1,
      targetProvider: "claudeAgent",
      targetModel: "claude-opus-5-5",
      targetRuntimeMode: "full-access",
      targetInteractionMode: "default",
      crossProvider: true,
    });
    expect(properties).toHaveProperty("durationMs");
    expect(Object.values(properties).some((value) => String(value).includes("mcp-core"))).toBe(
      false,
    );

    // Queue tools return only a sequence, so the receiving thread comes from the input.
    yield* server
      .callTool({
        name: "goat_queue_edit",
        arguments: { threadId: "mcp-core-other", queuedRunId: "mcp-core-queued", text: "secret" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    // The fork recorded a single event, so the next one is the queue edit.
    expect((yield* Deferred.await(recorded[1]!)).properties).toMatchObject({
      tool: "goat_queue_edit",
      outcome: "ok",
      callerProvider: "codex",
      targetProvider: "claudeAgent",
      crossProvider: true,
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkitWithoutProviders.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                id === threadId
                  ? shell(threadId, "codex", "gpt-5.5")
                  : shell(id, "claudeAgent", "claude-opus-5-5"),
              ),
            getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({ thread: shell(threadId, "codex", "gpt-5.5") } as never),
            dispatch: () => Effect.succeed({ sequence: 1 } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: "codex",
                models: [{ slug: "gpt-5.5", isCustom: false }],
              } as never,
              {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                driver: "claudeAgent",
                models: [{ slug: "claude-opus-5-5", isCustom: false }],
              } as never,
            ]),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              record: (event, properties) =>
                Deferred.succeed(recorded[recordedCount++]!, {
                  event,
                  properties: properties ?? {},
                }).pipe(Effect.asVoid),
              flush: Effect.void,
              recordOwners: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call("goat_thread_organize", { action: "pin" }, clientScope("auto"));
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "goat_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "goat_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "goat_thread_fork",
      { sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("a read-only client reads threads and is refused every write before it runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("read-only"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const configuration = yield* call("goat_thread_configuration_read", {
      threadId: "other-project-thread",
    });
    expect(configuration.isError).toBe(false);
    expect(configuration.structuredContent).toMatchObject({ runtimeMode: "auto" });

    const pinned = yield* call("goat_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(declaredFailure(pinned)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);

    const configure = yield* call("goat_thread_configure", {
      threadId: "other-project-thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    expect(declaredFailure(configure)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () =>
              Effect.sync(() => {
                dispatched.push("dispatch");
                return { sequence: 7 } as never;
              }),
          }),
        ),
      ),
    ),
  ),
);
const dispatched: Array<string> = [];

it.effect("refuses act-as-caller tools to a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "goat_task_create",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            find: () => Effect.succeed(null),
            rearm: () => Effect.void,
          }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("goat_schedule_update", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("goat_schedule_delete", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("goat_schedule_update", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            find: () => Effect.succeed(null),
            rearm: () => Effect.void,
          }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect.each(["goat_thread_interrupt", "goat_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "goat_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(
            Layer.mock(LaunchWatchService.LaunchWatchService)({
              find: () => Effect.succeed(null),
              rearm: () => Effect.void,
            }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
          ),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        ),
      ),
    ),
);

it.effect("discovers workflow stop targets and requires orchestration capability", () => {
  const threadId = ThreadId.make("workflow-parent");
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const subagentId = NodeId.make("workflow-coordinator");
  const itemId = TurnItemId.make("workflow-coordinator-activity");
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: shell.activeRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: "Workflow: checkout review",
      startedAt: shell.createdAt,
      completedAt: null,
      updatedAt: shell.updatedAt,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make("workflow-child"),
      prompt: "Review checkout",
      result: null,
    },
  };
  const stopped: Array<{ readonly threadId: ThreadId; readonly subagentId: string }> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = clientScope("full-access");
    const read = yield* server
      .callTool({ name: "goat_thread_read", arguments: { threadId, view: "activity" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(read.isError).toBe(false);
    const result = yield* decodeThreadReadResult(read.structuredContent);
    expect(result.items[0]?.subagentId).toBe(subagentId);
    const call = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name: "goat_workflow_stop",
          arguments: { threadId, subagentId: result.items[0]?.subagentId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const denied = yield* call({ ...scope, capabilities: new Set(["worktree"]) });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(stopped).toEqual([]);
    const allowed = yield* call(scope);
    expect(allowed.isError).toBe(false);
    expect(stopped).toEqual([{ threadId: "workflow-parent", subagentId: "workflow-coordinator" }]);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provide(
          Layer.mock(ThreadResultService.ThreadResultService)({
            forRun: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            find: () => Effect.succeed(null),
            rearm: () => Effect.void,
          }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getTimelinePage: () => Effect.succeed({ items: [row], totalItems: 1, hasMore: false }),
            stopWorkflow: (input) =>
              Effect.sync(() => {
                stopped.push(input);
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  );
});

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "goat_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("goat_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "goat_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    const discarded = yield* call(
      "goat_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-attachment-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "validates reason, records authenticated responders, and reads resolved questions through registration",
  () =>
    Effect.gen(function* () {
      const requestId = RuntimeRequestId.make("question-request");
      const targetId = ThreadId.make("asking");
      const now = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");
      const captured: OrchestrationV2ServerCommand[] = [];
      const shell = McpToolAccessTestkit.liveThreadShell(targetId);
      const projection = McpToolAccessTestkit.idleThreadProjection(shell);
      let request = {
        id: requestId,
        nodeId: NodeId.make("question-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      } as import("@goat/contracts").OrchestrationV2RuntimeRequest;
      const item: import("@goat/contracts").OrchestrationV2TurnItem = {
        id: TurnItemId.make("question-item"),
        type: "user_input_request",
        threadId: targetId,
        runId: null,
        nodeId: request.nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        requestId,
        questions: [{ id: "q", header: "Choice", question: "Continue?", options: [] }],
      };
      let rejection: OrchestratorQuestionAlreadyAnsweredError | undefined;
      const dependencies = layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed({ ...projection, runtimeRequests: [request], turnItems: [item] }),
            dispatch: (command) => {
              captured.push(command);
              return rejection === undefined
                ? Effect.succeed({ sequence: 7, storedEvents: [] })
                : Effect.fail(rejection);
            },
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const args = { threadId: targetId, requestId, answers: { q: "  Exact option  " } };
        for (const reason of [undefined, "", "   ", "R".repeat(2001)]) {
          const failure = yield* call("goat_pending_request_respond", {
            ...args,
            ...(reason === undefined ? {} : { reason }),
          }).pipe(Effect.flip);
          expect(failure._tag).toBe("InvalidParams");
        }
        expect(captured).toHaveLength(0);
        for (const reason of ["R", "R".repeat(2000)]) {
          const result = yield* call("goat_pending_request_respond", { ...args, reason });
          expect(result.structuredContent).toEqual({ sequence: 7 });
          expect(captured.at(-1)).toMatchObject({
            threadId: targetId,
            answers: args.answers,
            respondedBy: {
              type: "agent",
              threadId: scope.thread!.threadId,
              environmentId: null,
              title: scope.thread!.threadId,
              reason,
            },
          });
        }
        yield* call(
          "goat_pending_request_respond",
          { ...args, reason: "Outside reason" },
          clientScope("full-access"),
        );
        expect(captured.at(-1)).toMatchObject({
          respondedBy: { type: "client", reason: "Outside reason" },
        });
        const schema = Tool.getJsonSchema(ThreadToolkit.tools.goat_pending_request_respond);
        expect(schema.required).toContain("reason");
        expect(JSON.stringify(schema)).toContain('"maxLength":2000');
        for (const key of ["scope", "launchedBy"])
          expect(schema.properties).not.toHaveProperty(key);
        for (const key of ["host", "respondedBy"]) expect(schema.properties).toHaveProperty(key);
        const respondedBy = { type: "client" as const, reason: "Winner private reason" };
        const pendingRequest = request;
        for (const status of ["pending", "resolved", "expired", "cancelled"] as const) {
          request = {
            ...pendingRequest,
            status,
            resolvedAt: status === "pending" ? null : now,
            ...(status === "resolved" ? { respondedBy } : {}),
          };
          const result = yield* call("goat_pending_request_read", {
            threadId: targetId,
            requestId,
          });
          expect(result.isError).toBe(false);
          expect(result.structuredContent).toMatchObject({
            requestId,
            questions: item.questions,
            status,
            resolvedAt: status === "pending" ? null : DateTime.formatIso(now),
          });
        }
        request = {
          ...request,
          status: "resolved",
          respondedBy: { type: "user" },
          decision: "cancel",
        };
        const dismissal = yield* call("goat_pending_request_read", {
          threadId: targetId,
          requestId,
        });
        expect(dismissal.structuredContent).toMatchObject({
          status: "resolved",
          decision: "cancel",
          respondedBy: { type: "user" },
        });
        request = { ...request, status: "resolved", respondedBy };
        rejection = new OrchestratorQuestionAlreadyAnsweredError({
          commandId: CommandId.make("loser"),
          requestId,
          respondedBy,
          resolvedAt: now,
          status: "resolved",
        });
        for (const status of ["resolved", "pending"] as const) {
          request = { ...request, status };
          const result = yield* call("goat_pending_request_respond", { ...args, reason: "Loser" });
          expect(declaredFailure(result)).toMatchObject({
            code: "invalid_request",
            message: rejection.message,
          });
          expect(rejection.message).not.toContain(respondedBy.reason);
        }
        const before = captured.length;
        for (const kind of [
          "command",
          "file-read",
          "file-change",
          "mcp-elicitation",
          "permission",
        ] as const) {
          request = { ...request, kind, status: "pending" };
          const result = yield* call("goat_pending_request_respond", {
            ...args,
            reason: "No approval authority",
          });
          expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
        }
        expect(captured).toHaveLength(before);
      }).pipe(Effect.provide(dependencies));
    }),
);

it.effect("keeps ceiling codes and forwards questions to the user before and under the lock", () =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("target");
    const now = DateTime.makeUnsafe("2026-10-12T00:00:00Z");
    let preflight = true;
    let mode: "runtime" | "interaction" = "runtime";
    const shell = () =>
      McpToolAccessTestkit.liveThreadShell(targetId, {
        runtimeMode: preflight && mode === "runtime" ? "full-access" : "auto",
        interactionMode: "default",
      });
    const projection = () => ({
      ...McpToolAccessTestkit.idleThreadProjection(shell()),
      runtimeRequests: [
        {
          id: RuntimeRequestId.make("request"),
          nodeId: NodeId.make("node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: null,
        },
      ],
      turnItems: [{ type: "user_input_request", requestId: "request", questions: [] }],
    });
    const dependencies = layerThreadToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(
              id === ThreadId.make("plan-caller")
                ? McpToolAccessTestkit.liveThreadShell(id, {
                    runtimeMode: "auto",
                    interactionMode: "plan",
                  })
                : shell(),
            ),
          getProjectThreadRecords: () => Effect.succeed(projection() as never),
          dispatch: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (limit?.refused === undefined) return yield* Effect.die("Missing dispatch guard");
              yield* Ref.set(limit.refused, {
                mode,
                threadId: targetId,
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
              });
              return yield* new OrchestratorDispatchError({
                commandId: CommandId.make("raised"),
                commandType: "runtime-request.respond",
              });
            }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (invocation: McpInvocationContext.McpInvocationScope) =>
        server
          .callTool({
            name: "goat_pending_request_respond",
            arguments: {
              threadId: targetId,
              requestId: "request",
              answers: { q: "Yes" },
              reason: "R",
            },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      for (const stage of ["preflight", "locked"] as const) {
        preflight = stage === "preflight";
        for (const selectedMode of ["runtime", "interaction"] as const) {
          mode = selectedMode;
          const invocation =
            mode === "runtime"
              ? clientScope("auto")
              : { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("plan-caller") } };
          // The thread caller's plan ceiling needs a different shell from its target.
          const result = yield* call(invocation);
          expect(declaredFailure(result)).toMatchObject({
            code:
              mode === "runtime"
                ? "runtime_mode_escalation_denied"
                : "interaction_mode_escalation_denied",
            message: expect.stringContaining("forward it to the user"),
          });
        }
      }
    }).pipe(Effect.provide(dependencies));
  }),
);

it("declares every pending and launcher host-transport argument on strict schemas", () => {
  for (const [tool, keys] of [
    [
      ThreadToolkit.tools.goat_pending_request_list,
      ["host", "scope", "hosts", "launcherThreadId", "launcherEnvironmentId", "threadId"],
    ],
    [ThreadToolkit.tools.goat_pending_request_read, ["host", "threadId", "requestId"]],
    [
      ThreadToolkit.tools.goat_pending_request_respond,
      ["host", "threadId", "requestId", "reason", "respondedBy"],
    ],
    [ProjectToolkit.tools.goat_thread_launch, ["launchedBy"]],
    [OrchestratorToolkit.tools.goat_thread_wait, ["ignoreRequestIds"]],
  ] as const) {
    const schema = Tool.getJsonSchema(tool);
    // Production registration closes top-level schemas; raw Tool schemas remain open.
    for (const key of keys) expect(schema.properties).toHaveProperty(key);
  }
});

it.effect.each([false, true])(
  "SSH launch derives origin identity from invocation scope, thread=%s",
  (hasThread) =>
    Effect.gen(function* () {
      const captured: Array<SshRemoteDispatch.SshLaunchInput> = [];
      const watches: Array<Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0]> =
        [];
      const invocation = hasThread ? scope : clientScope("full-access");
      const remoteResult = {
        host: "box",
        cwd: "/repo",
        projectId: "project",
        projectCreated: false,
        threadId: "remote",
        runId: null,
        reportsSupported: true,
        workspaceStrategy: { type: "root" as const },
        runtimeMode: "full-access" as const,
        remoteServerKind: "managed" as const,
        notes: [],
      };
      const dependencies = Layer.mergeAll(
        Profiles.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
        NodeCrypto.layer,
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: invocation.environmentId,
            label: "test",
          } as never),
        }),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
          launch: (input, check) =>
            check.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  captured.push(input.launch);
                  return { correlationId: "fixture", launch: remoteResult, reportsSupported: true };
                }),
              ),
            ),
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
          register: (input) =>
            Effect.sync(() => {
              watches.push(input);
              return newLaunchWatch({
                ...input,
                host: input.host ?? null,
                incarnation: "test",
                notifyWebhook: input.notifyWebhook ?? false,
                now: 0,
              });
            }),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
        Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
        Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
        Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
        Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
        Layer.mock(SshHostSetup.SshHostSetup)({}),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          validateLaunchAttachments: (attachments) => Effect.succeed(attachments),
          launchThread: (input, check) =>
            check.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  captured.push(input);
                  return remoteResult;
                }),
              ),
            ),
        }),
      );
      const toolkit = yield* SshToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const result = yield* toolkit
        .handle("goat_ssh_thread_launch", { host: "box", cwd: "/repo", title: "Remote" })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(result.at(-1)?.result).toMatchObject({ threadId: "remote" });
      expect(watches).toEqual(
        hasThread
          ? [
              {
                launcherThreadId: threadId,
                host: "box",
                threadId: "remote",
                projectId: null,
                title: "Remote",
                runId: null,
                notifyWebhook: false,
                webhookTarget: null,
              },
            ]
          : [],
      );
      expect(captured[0]?.launchedBy).toEqual(
        hasThread
          ? {
              kind: "launch",
              threadId: scope.thread!.threadId,
              environmentId: scope.environmentId,
              environmentLabel: "test",
              threadTitle: McpToolAccessTestkit.liveThreadShell(threadId).title,
              via: "ssh_thread_launch",
            }
          : undefined,
      );
    }),
);

it.effect("pending toolkit host routing preserves target authority", () =>
  Effect.gen(function* () {
    const sent: Array<SshRemoteDispatch.SshHostToolCall> = [];
    const localTargets: Array<ThreadId> = [];
    const remoteId = ThreadId.make("remote-thread");
    const dependencies = McpHttpServer.layerThreadToolkit.pipe(
      Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
      Layer.provide(layerNoFleetSync),
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => {
            localTargets.push(id);
            return Effect.succeed(McpToolAccessTestkit.liveThreadShell(id));
          },
        }),
      ),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          connectedHosts: Effect.succeed([]),
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  sent.push(call);
                  return null;
                }),
              ),
              Effect.andThen(
                Effect.fail(
                  new SshRemoteDispatch.SshRemoteDispatchError({
                    reason: "remote_refused",
                    remoteCode: "runtime_mode_escalation_denied",
                    message: "Destination ceiling",
                  }),
                ),
              ),
            ),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (
        name: string,
        args: Record<string, unknown>,
        invocation: McpInvocationContext.McpInvocationScope,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      for (const name of ["goat_pending_request_list", "goat_pending_request_read"]) {
        const result = yield* call(
          name,
          { host: "box", threadId: remoteId, ...(name.endsWith("read") ? { requestId: "q" } : {}) },
          clientScope("read-only"),
        );
        expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
      }
      const launchedReadOnly = yield* call(
        "goat_pending_request_list",
        { scope: "launched" },
        clientScope("read-only"),
      );
      expect(declaredFailure(launchedReadOnly)).toMatchObject({ code: "capability_denied" });
      expect(sent).toEqual([]);
      const result = yield* call(
        "goat_pending_request_respond",
        {
          host: "box",
          threadId: remoteId,
          requestId: "q",
          answers: { q: "yes" },
          reason: "The API supports it",
        },
        scope,
      );
      expect(declaredFailure(result)).toMatchObject({
        code: "runtime_mode_escalation_denied",
        message: expect.stringContaining("forward it to the user"),
      });
      expect(localTargets).not.toContain(remoteId);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.arguments).not.toHaveProperty("host");
      for (const reason of [" ", "\n\t"]) {
        const failure = yield* call(
          "goat_pending_request_respond",
          {
            threadId: remoteId,
            requestId: "q",
            answers: {},
            reason: "Valid",
            respondedBy: {
              type: "agent",
              threadId: "foreign",
              environmentId: "foreign-env",
              title: null,
              reason,
            },
          },
          clientScope("full-access"),
        ).pipe(Effect.flip);
        expect(failure._tag).toBe("InvalidParams");
      }
      expect(sent).toHaveLength(1);
    }).pipe(Effect.provide(dependencies));
  }),
);

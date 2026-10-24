import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AttachmentCreateUploadUrlResult,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CloudMachines from "../../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedFolders from "../../project/ManagedProjectFolders.ts";
import * as Projects from "../../project/ProjectService.ts";
import * as RemoteDispatch from "../../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Repositories from "../../sourceControl/SourceControlRepositoryService.ts";
import * as SshDeviceAdd from "../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as WorkspaceSync from "../../sshRemote/SshWorkspaceSync.ts";
import * as ThreadResults from "../../threadResults/ThreadResultService.ts";
import * as HostThreads from "../HostThreadsMcpService.ts";
import * as LaunchWatches from "../LaunchWatchService.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import {
  idleThreadProjection,
  layerPermissionProfilesOff,
  liveThreadShell,
} from "../McpToolAccess.testkit.ts";
import * as PendingQuestions from "../PendingQuestionsMcpService.ts";
import * as RepositoryLaunch from "../RepositoryLaunchMcpService.ts";
import * as RepositoryReferences from "../RepositoryReferenceMcpService.ts";
import * as ThreadLaunch from "../ThreadLaunchMcpService.ts";
import * as ThreadSearch from "../ThreadSearchMcpService.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import * as ProjectHandlers from "./project/handlers.ts";
import { ProjectToolkit } from "./project/tools.ts";
import * as SshHandlers from "./ssh/handlers.ts";
import { SshToolkit } from "./ssh/tools.ts";
import * as ThreadHandlers from "./thread/handlers.ts";
import { ThreadToolkit } from "./thread/tools.ts";

const callerId = ThreadId.make("retry-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("retry-environment"),
  requestNamespace: "retry-session",
  thread: {
    threadId: callerId,
    providerSessionId: "retry-session",
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
  clientInfo: { name: "retry-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "retry-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
  );

/** Real registrations and admission; only the domain effects are counted substitutes. */
const fixture = () => {
  const performed: Array<unknown> = [];
  const capabilities = new Set(["orchestration"] as const);
  const record = (input: unknown) => performed.push(input);
  const dependencies = Layer.mergeAll(
    layerPermissionProfilesOff,
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, { ...scope, capabilities }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      getProjectThreadRecords: ({ threadId }) =>
        Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
      dispatch: (input) =>
        Effect.sync(() => ({ sequence: record(input), storedEvents: [], replayed: false })),
      sendToThread: (input) =>
        Effect.sync(() => {
          const sequence = record(input);
          // Intake consumes only the returned attachments; the handler returns the run identity.
          return {
            message: { attachments: input.attachments },
            run: { id: `sent-${sequence}`, status: "queued" },
          } as Threads.ThreadManagementSendResult;
        }),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [{ id: "schedule" }] } as never),
      runNow: (input) =>
        Effect.sync(() => {
          const sequence = record(input);
          return {
            task: { id: input.id, lastRunStatus: "succeeded", runCount: sequence, nextRunAt: null },
            threadId: `scheduled-${sequence}`,
          } as never;
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      create: (input) =>
        Effect.sync(() => {
          record(input);
          return {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-24T00:00:00.000Z",
            updatedAt: "2026-10-24T00:00:00.000Z",
            deletedAt: null,
          };
        }),
    }),
    Layer.mock(WorkspaceSync.SshWorkspaceSync)({
      handoffThread: (input) =>
        Effect.sync(() => {
          const sequence = record(input);
          return {
            operationId: `handoff-${sequence}`,
            remoteThreadId: ThreadId.make(`remote-${sequence}`),
            remoteProjectId: ProjectId.make("remote-project"),
            remoteRepoPath: "/projects/remote",
            branch: `handoff-${sequence}`,
          } as never;
        }),
    }),
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
      listHosts: () => Effect.succeed([{ alias: "box", source: "ssh-config" }]),
    }),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
    }),
    Layer.mock(ThreadResults.ThreadResultService)({}),
    Layer.mock(PendingQuestions.PendingQuestionsMcpService)({}),
    Layer.mock(ThreadSearch.ThreadSearchMcpService)({}),
    Layer.mock(HostThreads.HostThreadsMcpService)({}),
    Layer.mock(ManagedFolders.ManagedProjectFolders)({}),
    Layer.mock(Repositories.SourceControlRepositoryService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchMcpService)({}),
    Layer.mock(RepositoryReferences.RepositoryReferenceMcpService)({}),
    Layer.mock(RepositoryLaunch.RepositoryLaunchMcpService)({}),
    Layer.mock(LaunchWatches.LaunchWatchService)({}),
    Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({}),
    Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
    Layer.mock(SshHostSetup.SshHostSetup)({}),
    Layer.mock(CloudMachines.CloudMachineService)({}),
  );
  const served = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(ThreadToolkit, ThreadHandlers.layer),
    McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
    McpHttpServer.toolkitRegistration(AttachmentToolkit, AttachmentHandlers.layer),
    McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer),
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(dependencies),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-retry-keys-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { performed, served, capabilities };
};

const requests = [
  {
    name: "goat_thread_fork",
    args: { sourcePoint: { type: "latest_stable" } },
    result: { targetThreadId: expect.any(String) },
  },
  {
    name: "goat_thread_merge_back",
    args: { targetThreadId: "target", sourcePoint: { type: "latest_stable" } },
    result: { targetThreadId: "target" },
  },
  {
    name: "goat_thread_configure",
    args: { modelSelection: { instanceId: "codex", model: "gpt-5" } },
    result: { sequence: 1 },
  },
  {
    name: "goat_schedule_run",
    args: { taskId: "schedule" },
    result: { threadId: "scheduled-1", runCount: 1 },
  },
  {
    name: "goat_project_create",
    args: { title: "Retry project", workspaceRoot: "/projects/retry" },
    result: { title: "Retry project" },
  },
  {
    name: "goat_ssh_thread_handoff",
    args: { host: "box" },
    result: { remoteThreadId: "remote-1" },
  },
];

it.effect.each(requests)(
  "$name runs once for the same clientRequestId",
  ({ name, args, result }) => {
    const { performed, served } = fixture();
    return Effect.gen(function* () {
      const first = yield* call(name, { ...args, clientRequestId: "request-1" });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject(result);
      const repeated = yield* call(name, { ...args, clientRequestId: "request-1" });
      expect(repeated.content).toEqual(first.content);
      expect(performed).toHaveLength(1);
      expect(performed[0]).not.toHaveProperty("clientRequestId");
      yield* call(name, { ...args, clientRequestId: "request-2" });
      expect(performed).toHaveLength(2);
    }).pipe(Effect.provide(served));
  },
);

it.effect.each(requests.slice(0, 3))(
  "$name checks the orchestration credential before replay",
  ({ name, args: request }) => {
    const { performed, served, capabilities } = fixture();
    return Effect.gen(function* () {
      const args = { ...request, clientRequestId: "thread-1" };
      yield* call(name, args);
      capabilities.clear();
      const refused = yield* call(name, args);
      expect(refused.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("capability_denied") }),
      ]);
      expect(performed).toHaveLength(1);
    }).pipe(Effect.provide(served));
  },
);

it.effect("attachment sends reuse the first message and claimed files on a keyed retry", () => {
  const { performed, served, capabilities } = fixture();
  return Effect.gen(function* () {
    const upload = { name: "image.png", mimeType: "image/png", sizeBytes: 4 };
    const prepared = yield* call("goat_attachment_prepare_upload", { upload });
    const { attachmentId } = Schema.decodeUnknownSync(AttachmentCreateUploadUrlResult)(
      prepared.structuredContent,
    );
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(config.attachmentsDir + "/" + attachmentId + ".png", new Uint8Array(4));
    const args = {
      attachments: [{ ...upload, type: "image", id: attachmentId }],
      clientRequestId: "attachment-1",
    };
    const first = yield* call("goat_thread_send_attachments", args);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      messageId: expect.any(String),
      runId: "sent-1",
    });
    expect((yield* call("goat_thread_send_attachments", args)).content).toEqual(first.content);
    expect(performed).toHaveLength(1);
    yield* call("goat_thread_send_attachments", { ...args, clientRequestId: "attachment-2" });
    capabilities.clear();
    const denied = yield* call("goat_thread_send_attachments", args);
    expect(denied.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("capability_denied") }),
    ]);
    expect(performed).toHaveLength(2);
  }).pipe(Effect.provide(served));
});

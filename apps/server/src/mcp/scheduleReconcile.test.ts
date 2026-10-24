import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as RemoteDispatch from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import type { ScheduledTaskUpsertInput } from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";
import * as GitVcs from "../vcs/GitVcsDriver.ts";
import * as HostThreads from "./HostThreadsMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import {
  idleThreadProjection,
  layerPermissionProfilesOff,
  liveThreadShell,
} from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadata from "./ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

const projectId = ProjectId.make("schedule-reconcile-project");
const caller: McpInvocationScope = {
  environmentId: EnvironmentId.make("schedule-reconcile-environment"),
  requestNamespace: "schedule-reconcile-client",
  thread: undefined,
  client: { sessionId: "schedule-reconcile", label: "test", access: "full-access" },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const disabledTask: ScheduledTask = {
  id: ScheduledTaskId.make("manual-schedule"),
  projectId,
  threadId: null,
  title: "Manual work",
  prompt: "Run work",
  enabled: false,
  schedule: { type: "interval", everyMs: 60_000 },
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: "2026-10-24T01:00:00.000Z",
  lastRunStatus: "succeeded",
  lastRunError: null,
  runCount: 2,
};

it.effect("schedule.list distinguishes another successful manual run of a disabled task", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make(disabledTask);
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(layerNoFleetSync),
          Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcs.GitVcsDriver)({})),
          Layer.provide(Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ServerSettings.layerTest(),
              Layer.mock(Threads.ThreadManagementService)({}),
              Layer.mock(Projects.ProjectService)({}),
              Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
                list: () => Effect.succeed([]),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({
                list: () => Ref.get(stored).pipe(Effect.map((task) => ({ tasks: [task] }))),
              }),
            ),
          ),
        ),
      ),
    );
    const before = yield* service.listScheduledTasks(caller, { projectId });
    expect(before.tasks[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunStatus: "succeeded",
      runCount: 2,
      lastRunAt: "2026-10-24T01:00:00.000Z",
    });
    yield* Ref.update(stored, (task) => ({
      ...task,
      runCount: 3,
      lastRunAt: "2026-10-24T02:00:00.000Z",
    }));
    const after = yield* service.listScheduledTasks(caller, { projectId });
    expect(after.tasks[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunStatus: "succeeded",
      runCount: 3,
      lastRunAt: "2026-10-24T02:00:00.000Z",
    });
  }),
);

const updateCaller = ThreadId.make("schedule-update-caller");
const updateScope: McpInvocationScope = {
  environmentId: EnvironmentId.make("schedule-update-environment"),
  requestNamespace: "schedule-update-session",
  thread: {
    threadId: updateCaller,
    providerSessionId: "schedule-update-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "schedule-update", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "schedule-update", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, updateScope),
  );
const webhookTask: ScheduledTask = {
  ...disabledTask,
  id: ScheduledTaskId.make("webhook-schedule"),
  projectId: liveThreadShell(updateCaller).projectId,
  enabled: true,
  schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
  runtimeMode: "approval-required",
  interactionMode: "default",
  webhook: { path: "/hooks/webhook-schedule/token", url: null, hasSecret: false },
};

/**
 * update_scheduled_task served through its real registration, admission and service. Only the
 * schedule store is a substitute: each upsert is where a secretRef is consumed.
 */
const updateFixture = () => {
  const upserts: Array<ScheduledTaskUpsertInput> = [];
  const parked: { next?: Deferred.Deferred<void> } = {};
  const stored = { task: webhookTask };
  const services = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(liveThreadShell(id, { runtimeMode: "approval-required" })),
      getProjectThreadRecords: ({ threadId }) =>
        Effect.succeed(
          idleThreadProjection(liveThreadShell(threadId, { runtimeMode: "approval-required" })),
        ),
      getThreadRecords: (threadId) =>
        Effect.succeed(
          idleThreadProjection(liveThreadShell(threadId, { runtimeMode: "approval-required" })),
        ),
    }),
    Layer.mock(Projects.ProjectService)({}),
    Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.sync(() => ({ tasks: [stored.task] })),
      upsert: (input) =>
        Effect.suspend(() => {
          upserts.push(input);
          const park = parked.next;
          if (park !== undefined)
            return Effect.andThen(Deferred.succeed(park, undefined), Effect.never);
          const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
          stored.task = {
            ...stored.task,
            title: input.title,
            schedule:
              input.schedule.type === "webhook"
                ? { ...input.schedule, signature: null }
                : input.schedule,
            webhook: {
              ...stored.task.webhook!,
              hasSecret: signature != null,
              ...(signature?.secretRef === undefined ? {} : { secretRef: signature.secretRef }),
            },
          } as ScheduledTask;
          return Effect.succeed({ task: stored.task });
        }),
    }),
  );
  const served = McpHttpServer.toolkitRegistration(
    OrchestratorToolkit,
    OrchestratorHandlers.layer,
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        layerPermissionProfilesOff,
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, updateScope),
        Layer.mock(HostThreads.HostThreadsMcpService)({}),
        Layer.mock(ThreadMetadata.ThreadMetadataMcpService)({}),
        Layer.mock(ThreadResults.ThreadResultService)({}),
      ),
    ),
    Layer.provideMerge(
      OrchestratorMcpService.layer.pipe(
        Layer.provide(layerNoFleetSync),
        Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcs.GitVcsDriver)({})),
        Layer.provide(Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provideMerge(services),
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { upserts, parked, stored, served };
};

const rotation = {
  scheduledTaskId: webhookTask.id,
  title: "Rotated hook",
  schedule: {
    type: "webhook",
    signature: { header: "X-Signature", encoding: "hex", prefix: "", secretRef: "secret-ref-1" },
  },
};

it.effect(
  "update_scheduled_task saves a secretRef once and replays its result for the same key",
  () => {
    const { upserts, served } = updateFixture();
    return Effect.gen(function* () {
      const first = yield* callTool("goat_schedule_update", {
        ...rotation,
        clientRequestId: "update-1",
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        title: "Rotated hook",
        webhookSignature: "set",
        webhookSignatureSecretRef: "secret-ref-1",
      });
      const repeated = yield* callTool("goat_schedule_update", {
        ...rotation,
        clientRequestId: "update-1",
      });
      expect(repeated.content).toEqual(first.content);
      expect(upserts).toHaveLength(1);
      // The reconcile read shows which ref the stored secret came from.
      const listed = yield* callTool("goat_schedule_list", {});
      expect(listed.structuredContent).toMatchObject({
        tasks: [{ webhookSignatureSecretRef: "secret-ref-1" }],
      });
      const reused = yield* callTool("goat_schedule_update", {
        ...rotation,
        title: "Another title",
        clientRequestId: "update-1",
      });
      expect(reused.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("idempotency_mismatch") }),
      ]);
      expect(upserts).toHaveLength(1);
    }).pipe(Effect.provide(served));
  },
);

it.effect("update_scheduled_task checks the task's modes again before it replays", () => {
  const { upserts, stored, served } = updateFixture();
  return Effect.gen(function* () {
    const args = { scheduledTaskId: webhookTask.id, title: "Renamed", clientRequestId: "update-2" };
    expect((yield* callTool("goat_schedule_update", args)).isError).not.toBe(true);
    // The user raised the task above this caller's approval-required mode after the first call.
    stored.task = { ...stored.task, runtimeMode: "full-access" };
    const replay = yield* callTool("goat_schedule_update", args);
    expect(replay.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("runtime_mode_escalation_denied") }),
    ]);
    expect(upserts).toHaveLength(1);
  }).pipe(Effect.provide(served));
});

it.effect(
  "an interrupted update_scheduled_task never saves again and names list_scheduled_tasks",
  () => {
    const { upserts, parked, served } = updateFixture();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      parked.next = started;
      const args = { ...rotation, clientRequestId: "update-lost" };
      const first = yield* Effect.forkChild(callTool("goat_schedule_update", args));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      delete parked.next;
      const retried = yield* callTool("goat_schedule_update", args);
      expect(retried.content).toEqual([
        expect.objectContaining({
          text: expect.stringMatching(/list_scheduled_tasks[\s\S]*"reconcile":"schedule\.list"/),
        }),
      ]);
      expect(upserts).toHaveLength(1);
    }).pipe(Effect.provide(served));
  },
);

import * as FleetSync from "../goatclaw/FleetSync.ts";
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as Stream from "effect/Stream";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  type OrchestrationV2StoredEvent,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
} from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import Migration0062 from "../persistence/Migrations/091_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/092_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/094_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/096_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/101_MemoryTaskGrantCeiling.ts";
import { forceStopDelegatedTask } from "../orchestration-v2/delegatedForceStop.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

export const threadId = ThreadId.make("parent");
export const parentRunId = RunId.make("parent-run");
export const remoteThreadId = ThreadId.make("child-on-host");
export const remoteRunId = RunId.make("launched-run-A");
const instanceId = ProviderInstanceId.make("remote-only");
export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "parent-session",
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "parent-session",
  },
  client: undefined,
  issuedAt: 1,
  capabilities: new Set(["orchestration"]),
};
export const input: OrchestratorMcpDelegateTaskInput = {
  task: "Inspect the remote repository",
  target: { host: "box", providerInstanceId: instanceId, model: "remote-model" },
  remote: { cwd: "/workspace/repo" },
  clientRequestId: "one-task",
};
export const catalog: OrchestratorMcpCapabilitiesResult = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: instanceId,
      driverKind: ProviderDriverKind.make("claude"),
      displayName: "Remote Claude",
      models: [{ id: "remote-model", label: null }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
};

/** goatclaw on forwards the owner ceiling; fleetReach is what the destination's sync reports. */
export const fixtureWith = Effect.fnUntraced(function* (
  options: { readonly fleetReach?: FleetSync.HostReach } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const fleetReach = options.fleetReach;
  if (fleetReach === undefined) {
    yield* Migration0062;
    yield* Migration0063;
    yield* Migration0065;
    yield* Migration0068;
    yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
    yield* Migration0073;
  } else {
    // goatclaw reads lanes and the caller's runtime mode from the real schema.
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', 'Parent', 'codex', 'full-access', 'default', '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', '{}')`;
  }
  const now = yield* DateTime.now;
  let shell: OrchestrationV2ThreadShell | null = liveThreadShell(threadId, {
    activeRunId: parentRunId,
  });
  const projection = {
    ...idleThreadProjection(shell),
    subagents: [] as Array<OrchestrationV2Subagent>,
    runs: [
      {
        id: parentRunId,
        threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: shell.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("parent-message"),
        rootNodeId: NodeId.make("root"),
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
  };
  const registered = yield* Deferred.make<void>();
  const launchEntered = yield* Deferred.make<void>();
  const launchRelease = yield* Deferred.make<void>();
  const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const calls = yield* Queue.unbounded<{
    input: SshRemoteDispatch.SshHostToolCall;
    reply: Deferred.Deferred<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  }>();
  const receipts = new Set<string>();
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const subscribed = yield* Deferred.make<void>();
  const launches: Array<SshRemoteDispatch.SshLaunchInput> = [];
  const metadataCalls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  let metadataPaused = false;
  let phase: "none" | "before" | "after" = "none";
  let launchRunId: string | null = remoteRunId;
  let launchFailure: SshRemoteDispatch.SshRemoteDispatchError | undefined;
  let beforeLaunch: (() => void) | undefined;
  let beforeRegistrationFailure = false;
  let afterRegistration: (() => void) | undefined;
  let hostCatalog = catalog;
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerSettings.layerTest(
      fleetReach === undefined ? {} : { goatclaw: { enabled: true, defaultProfile: "owner" } },
    ),
    Layer.succeed(SqlClient.SqlClient, sql),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (id) =>
        id === threadId
          ? Effect.succeed(projection)
          : Effect.die("Remote child must never load a local projection"),
      getThreadShell: () => Effect.sync(() => shell),
      // The real ownership decision over this projection; a refused force stops nothing.
      forceStopDelegatedTask: (input) =>
        forceStopDelegatedTask(
          {
            getThreadRecords: () => Effect.succeed(projection),
            getThreadShell: () => Effect.sync(() => shell),
            forceStop: () => Effect.die("A refused Force stop must stop nothing"),
          },
          input,
        ),
      getThreadEventSequence: () => Effect.succeed(receipts.size),
      streamStoredEventsFrom: (input) => {
        assert.equal(input?.threadId, threadId);
        assert.equal(input?.eventType, "subagent.updated");
        return Stream.unwrap(
          Deferred.succeed(subscribed, undefined).pipe(
            Effect.as(
              Stream.fromQueue(events).pipe(
                Stream.filter((stored) => stored.sequence > (input?.afterSequence ?? 0)),
              ),
            ),
          ),
        );
      },
      dispatch: (command) =>
        Effect.gen(function* () {
          if (receipts.has(command.commandId)) return { sequence: receipts.size, storedEvents: [] };
          receipts.add(command.commandId);
          if (command.type === "delegated_task.remote.register") {
            projection.subagents.push({
              id: derive.delegatedTaskNode({ commandId: command.commandId }),
              threadId,
              runId: command.parentRunId,
              parentNodeId: command.parentNodeId,
              origin: "app_owned",
              createdBy: "agent",
              driver: command.driver,
              providerInstanceId: command.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              remote: command.remote,
              prompt: command.task,
              title: command.title ?? null,
              model: command.modelSelection.model,
              modelSelection: command.modelSelection,
              ...(command.role === undefined ? {} : { role: command.role }),
              parentModelSelection: command.parentModelSelection,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              completionWake: command.completionWake ?? "always",
            });
            yield* Deferred.succeed(registered, undefined);
          } else if (
            command.type === "delegated_task.remote.progress" ||
            command.type === "delegated_task.remote.result"
          ) {
            const task = projection.subagents.find((task) => task.id === command.taskId);
            if (task !== undefined && task.remote !== undefined) {
              if (command.type === "delegated_task.remote.progress" && task.result === null) {
                const updated: OrchestrationV2Subagent = {
                  ...task,
                  remote: {
                    ...task.remote,
                    threadId: command.remoteThreadId ?? task.remote.threadId,
                  },
                  progress: command.summary ?? "",
                };
                projection.subagents.splice(projection.subagents.indexOf(task), 1, updated);
              } else if (command.type === "delegated_task.remote.result" && task.result === null) {
                projection.subagents.splice(projection.subagents.indexOf(task), 1, {
                  ...task,
                  status: command.status,
                  result: command.summary,
                });
              }
            }
          }
          if (command.type === "delegated_task.wake-policy") {
            const task = projection.subagents.find((task) => task.id === command.taskId);
            if (task !== undefined)
              projection.subagents.splice(projection.subagents.indexOf(task), 1, {
                ...task,
                completionWake: command.completionWake,
              });
          }
          if (
            command.type === "delegated_task.remote.progress" ||
            command.type === "delegated_task.remote.result"
          ) {
            const task = projection.subagents.find((task) => task.id === command.taskId);
            if (task !== undefined)
              yield* Queue.offer(events, {
                sequence: receipts.size,
                commandId: command.commandId,
                event: {
                  id: EventId.make(`event:${command.commandId}`),
                  type: "subagent.updated",
                  threadId,
                  runId: parentRunId,
                  nodeId: task.id,
                  occurredAt: now,
                  payload: task,
                },
              });
          }
          yield* Queue.offer(commands, command);
          return { sequence: receipts.size, storedEvents: [] };
        }),
    }),
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
      callHostTool: (call, authorize) =>
        Effect.gen(function* () {
          yield* authorize;
          if (call.tool === "orchestrator_capabilities") return hostCatalog;
          // Optional task metadata is a separate read from the coordinator's
          // report wait and interrupt calls, whose ordering these tests control.
          if (call.tool === "goat_thread_status") {
            metadataCalls.push(call);
            if (metadataPaused) return yield* Effect.never;
            return {
              threadId: remoteThreadId,
              title: "Remote task",
              phase: "running",
              terminal: false,
              run: null,
              queuedRunId: null,
              pendingRequest: null,
              lastActivityAt: now,
              lastMessage: null,
              lastError: null,
              watch: { pendingRunIds: [], lastReportedRunId: null, webhook: false },
            };
          }
          const reply = yield* Deferred.make<unknown, SshRemoteDispatch.SshRemoteDispatchError>();
          yield* Queue.offer(calls, { input: call, reply });
          return yield* Deferred.await(reply);
        }),
      launchThread: (launch, authorize) =>
        Effect.gen(function* () {
          launches.push(launch);
          beforeLaunch?.();
          if (phase === "before") {
            yield* Deferred.succeed(launchEntered, undefined);
            yield* Deferred.await(launchRelease);
          }
          if (beforeRegistrationFailure && launchFailure !== undefined) return yield* launchFailure;
          yield* authorize;
          afterRegistration?.();
          if (afterRegistration !== undefined) yield* authorize;
          if (phase === "after") {
            yield* Deferred.succeed(launchEntered, undefined);
            yield* Deferred.await(launchRelease);
          }
          if (launchFailure !== undefined) return yield* launchFailure;
          return {
            host: "box",
            cwd: launch.cwd,
            projectId: "remote-project",
            projectCreated: false,
            threadId: remoteThreadId,
            runId: launchRunId,
            reportsSupported: true,
            workspaceStrategy: { type: "root" },
            runtimeMode: launch.runtimeMode,
            remoteServerKind: null,
            notes: [],
          };
        }),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.die("Remote model must not use origin catalog"),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.die("Remote model must not use origin adapters"),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
  );
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      fleetReach === undefined
        ? layerNoFleetSync
        : Layer.mock(FleetSync.GoatclawFleetSync)({
            ensure: () => Effect.succeed(fleetReach),
          }),
    ),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(RemoteDispatchCoordinator.layer),
    Layer.provide(dependencies),
  );
  return {
    sql,
    layer,
    projection,
    commands,
    calls,
    launches,
    metadataCalls,
    pauseMetadata: () => {
      metadataPaused = true;
    },
    registered,
    subscribed,
    launchEntered,
    launchRelease,
    phase: (value: typeof phase) => {
      phase = value;
    },
    unknown: () => {
      launchRunId = null;
    },
    refuse: (reason: SshRemoteDispatch.SshRemoteDispatchError["reason"]) => {
      launchFailure = new SshRemoteDispatch.SshRemoteDispatchError({
        reason,
        message: "Launch refused or unanswered",
      });
    },
    failBeforeRegistration: () => {
      beforeRegistrationFailure = true;
    },
    recoverLaunch: () => {
      launchFailure = undefined;
      beforeRegistrationFailure = false;
    },
    afterRegistration: (value: () => void) => {
      afterRegistration = value;
    },
    shell: (value: OrchestrationV2ThreadShell | null) => {
      shell = value;
    },
    beforeLaunch: (value: () => void) => {
      beforeLaunch = value;
    },
    /** What the host's orchestrator_capabilities answers, as an older or newer GOAT would. */
    hostCatalog: (value: OrchestratorMcpCapabilitiesResult) => {
      hostCatalog = value;
    },
  };
});
export const fixture = fixtureWith();
export const database = NodeSqliteClient.layer({ filename: ":memory:" });

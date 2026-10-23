import * as FleetSync from "../goatclaw/FleetSync.ts";
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as Stream from "effect/Stream";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  OrchestratorMcpFailure,
  type OrchestrationV2StoredEvent,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  RuntimeRequestId,
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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import Migration0062 from "../persistence/Migrations/069_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/070_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/072_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/074_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/079_MemoryTaskGrantCeiling.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const threadId = ThreadId.make("parent");
const parentRunId = RunId.make("parent-run");
const remoteThreadId = ThreadId.make("child-on-host");
const remoteRunId = RunId.make("launched-run-A");
const instanceId = ProviderInstanceId.make("remote-only");
const scope: McpInvocationScope = {
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
const input: OrchestratorMcpDelegateTaskInput = {
  task: "Inspect the remote repository",
  target: { host: "box", providerInstanceId: instanceId, model: "remote-model" },
  remote: { cwd: "/workspace/repo" },
  clientRequestId: "one-task",
};
const catalog: OrchestratorMcpCapabilitiesResult = {
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
const fixtureWith = Effect.fnUntraced(function* (
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
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
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
          if (call.tool === "orchestrator_capabilities") return catalog;
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
  };
});
const fixture = fixtureWith();
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const encodeFailure = Schema.encodeEffect(OrchestratorMcpFailure);
const isRemoteDispatchError = Schema.is(RemoteDispatchCoordinator.RemoteDispatchError);

it.effect(
  "preserves a pre-registration storage failure without exposing its cause on the wire",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // Reproduce the stale fixture schema without changing caller authority or SSH behavior.
      yield* f.sql`ALTER TABLE remote_dispatches DROP COLUMN memory_grant_ceiling`;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") return;
        const error = result.failure;
        assert.equal(error.code, "orchestration_error");
        assert.ok(isRemoteDispatchError(error.cause));
        assert.equal(error.cause.stage, "storage");
        assert.ok(SqlError.isSqlError(error.cause.cause));
        const driverCause = error.cause.cause.reason.cause;
        assert.ok(driverCause instanceof Error);
        assert.match(driverCause.message, /no column named memory_grant_ceiling/u);
        const encoded = yield* encodeFailure(error);
        assert.deepStrictEqual(encoded, {
          _tag: "OrchestratorMcpFailure",
          code: "orchestration_error",
          message: "Remote dispatch failed before task registration.",
        });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), encoded);
        assert.equal(f.launches.length, 0);
        assert.equal(f.projection.subagents.length, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect(
  "remote async delegation, retries and cancellation do not await optional task metadata",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.pauseMetadata();
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.delegateTask(scope, { ...input, role: "review" });
        const retry = yield* service.delegateTask(scope, { ...input, role: "review" });
        assert.equal(first.role, "review");
        assert.deepEqual(first.parentModelSelection, f.projection.runs[0]!.modelSelection);
        assert.deepEqual(first.modelSelection, f.projection.subagents[0]!.modelSelection);
        assert.equal(first.status, "running");
        assert.equal(retry.taskId, first.taskId);
        assert.equal(f.launches.length, 1);
        yield* Queue.take(f.calls);
        yield* f.sql`UPDATE remote_dispatches SET state = 'lost'`;
        const cancelled = yield* service.cancelTask(scope, { taskId: first.taskId });
        assert.equal(cancelled.status, "failed");
        assert.equal(f.metadataCalls.length, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect.each([
  { sync: { state: "applied" as const }, enforcesCeilings: true },
  { sync: { state: "pending" as const, message: "box is offline." }, enforcesCeilings: false },
])(
  "remote delegation with goatclaw on says when box has not confirmed the ceiling ($sync.state)",
  (fleetReach) =>
    Effect.gen(function* () {
      const f = yield* fixtureWith({ fleetReach });
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.delegateTask(scope, input);
        const replay = yield* service.delegateTask(scope, input);
        assert.equal(f.launches.length, 1);
        assert.equal(f.launches[0]?.permissionProfileCeiling?.id, "owner");
        assert.deepEqual(
          first.ceiling,
          fleetReach.enforcesCeilings
            ? undefined
            : {
                enforcement: "unconfirmed",
                host: "box",
                sync: fleetReach.sync,
                message: first.ceiling?.message ?? "",
              },
        );
        assert.match(first.ceiling?.message ?? "box has not confirmed", /box has not confirmed/);
        // The replay forwarded nothing, so it claims nothing about a ceiling.
        assert.equal(replay.taskId, first.taskId);
        assert.isUndefined(replay.ceiling);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("remote blocking delegation observes the result without optional task metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.pauseMetadata();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const waiting = yield* service
        .delegateTask(scope, { ...input, mode: "wait" })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(f.calls);
      assert.equal(call.input.tool, "goat_origin_reports_wait");
      yield* Deferred.await(f.subscribed);
      yield* Deferred.succeed(call.reply, {
        threadId: remoteThreadId,
        reports: [],
        hasMore: false,
        latestRunId: remoteRunId,
        observedRun: { runId: remoteRunId, status: "completed", summary: "Saved result" },
        timedOut: false,
      });
      const result = yield* Fiber.join(waiting);
      assert.equal(result.status, "completed");
      assert.equal(result.summary, "Saved result");
      assert.equal(f.metadataCalls.length, 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect(
  "remote models are validated on the destination and status never loads a remote child locally",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const handle = yield* service.delegateTask(scope, {
          ...input,
          runtimeMode: "auto-accept-edits",
          remote: {
            cwd: "/workspace/repo",
            workspace: { type: "worktree", branch: "feature/task" },
          },
        });
        assert.equal(handle.status, "running");
        assert.equal(handle.host, "box");
        assert.equal(handle.childThreadId, remoteThreadId);
        assert.equal(handle.childRunId, null);
        assert.equal(handle.hasPendingChildRuns, false);
        assert.equal(handle.resultContextTransferId, null);
        assert.equal(f.launches[0]?.runtimeMode, "auto-accept-edits");
        assert.deepEqual(f.launches[0]?.workspace, { type: "worktree", branch: "feature/task" });
        assert.deepEqual(f.launches[0]?.launchedBy, {
          kind: "launch",
          threadId,
          environmentId: scope.environmentId,
          environmentLabel: null,
          threadTitle: f.projection.thread.title,
          via: "delegate_task",
        });
        const call = yield* Queue.take(f.calls);
        assert.equal(call.input.arguments.watchRunId, remoteRunId);
        yield* Deferred.succeed(call.reply, {
          threadId: remoteThreadId,
          reports: [],
          hasMore: false,
          latestRunId: RunId.make("later-B"),
          observedRun: { runId: remoteRunId, status: "completed", summary: "A finished" },
          timedOut: false,
        });
        let result = yield* Queue.take(f.commands);
        while (result.type !== "delegated_task.remote.result")
          result = yield* Queue.take(f.commands);
        const status = yield* service.taskStatus(scope, handle.taskId);
        assert.equal(status.status, "completed");
        assert.equal(status.summary, "A finished");
        assert.equal(status.latestTerminalSummary, "A finished");
        assert.equal((yield* service.delegateTask(scope, input)).taskId, handle.taskId);
        assert.equal(f.launches.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("a remote task's question releases a waiting delegate and shows in task_status", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const waiting = yield* service
        .delegateTask(scope, { ...input, mode: "wait", timeoutMs: 600_000 })
        .pipe(Effect.forkChild);
      const question = RuntimeRequestId.make("request-1");
      const call = yield* Queue.take(f.calls);
      yield* Deferred.succeed(call.reply, {
        threadId: remoteThreadId,
        reports: [],
        hasMore: false,
        latestRunId: remoteRunId,
        observedRun: {
          runId: remoteRunId,
          status: "running",
          summary: null,
          pendingRequestIds: [question],
        },
        timedOut: false,
      });
      const released = yield* Fiber.join(waiting);
      assert.equal(released.status, "running");
      assert.equal(released.waitTimedOut, false);
      assert.deepEqual(released.pendingRequestIds, [question]);
      assert.deepEqual((yield* service.taskStatus(scope, released.taskId)).pendingRequestIds, [
        question,
      ]);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect.each(["before", "after"] as const)(
  "duplicate delegate calls follow one SSH launch paused %s registration",
  (phase) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.phase(phase);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const owner = yield* service.delegateTask(scope, input).pipe(Effect.forkChild);
        yield* Deferred.await(f.launchEntered);
        const duplicate = yield* service.delegateTask(scope, input).pipe(Effect.forkChild);
        yield* Deferred.succeed(f.launchRelease, undefined);
        const first = yield* Fiber.join(owner);
        const second = yield* Fiber.join(duplicate);
        assert.equal(first.taskId, second.taskId);
        assert.equal(f.launches.length, 1);
        assert.equal(f.projection.subagents.length, 1);
        assert.equal(f.projection.subagents[0]?.status, "running");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect.each(["remote_refused", "host_unavailable"] as const)(
  "returns a durable failed handle for %s after registration without relaunching",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.refuse(reason);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const handle = yield* service.delegateTask(scope, input);
        assert.equal(handle.status, "failed");
        assert.equal(handle.childThreadId, null);
        assert.include(
          handle.summary ?? "",
          reason === "remote_refused" ? "Remote launch refused" : "launch outcome unknown",
        );
        assert.equal((yield* service.taskStatus(scope, handle.taskId)).status, "failed");
        assert.equal((yield* service.delegateTask(scope, input)).taskId, handle.taskId);
        assert.equal(f.launches.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("unknown launch retains the known remote child handle", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.unknown();
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const handle = yield* service.delegateTask(scope, input);
      assert.equal(handle.status, "failed");
      assert.equal(handle.childThreadId, remoteThreadId);
      assert.equal((yield* service.taskStatus(scope, handle.taskId)).childThreadId, remoteThreadId);
      assert.equal(yield* Queue.size(f.calls), 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect.each(["host-only", "remote-only", "model", "provider", "driver", "options"] as const)(
  "rejects %s before registering or launching",
  (invalid) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const request: OrchestratorMcpDelegateTaskInput =
        invalid === "host-only"
          ? { ...input, remote: undefined }
          : invalid === "remote-only"
            ? { ...input, target: undefined }
            : {
                ...input,
                target: {
                  ...input.target,
                  ...(invalid === "model"
                    ? { model: "unlisted" }
                    : invalid === "provider"
                      ? { providerInstanceId: ProviderInstanceId.make("missing") }
                      : invalid === "driver"
                        ? { driverKind: ProviderDriverKind.make("codex") }
                        : { options: [{ id: "unlisted", value: true }] }),
                },
              };
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, request).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(f.launches.length, 0);
        assert.equal(f.projection.subagents.length, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect.each(["read-only", "capability", "plan", "runtime", "inactive", "missing"] as const)(
  "refuses %s remote callers before launch",
  (denied) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const caller =
        denied === "read-only"
          ? {
              ...scope,
              client: { access: "read-only" as const, sessionId: "readonly", label: "readonly" },
            }
          : denied === "capability"
            ? {
                ...scope,
                capabilities: new Set<
                  McpInvocationScope["capabilities"] extends ReadonlySet<infer Capability>
                    ? Capability
                    : never
                >(),
              }
            : scope;
      if (denied === "plan")
        f.shell(liveThreadShell(threadId, { activeRunId: parentRunId, interactionMode: "plan" }));
      if (denied === "runtime")
        f.shell(liveThreadShell(threadId, { activeRunId: parentRunId, runtimeMode: "auto" }));
      if (denied === "inactive") f.shell(liveThreadShell(threadId, { activeRunId: null }));
      if (denied === "missing") f.shell(null);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(caller, input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(f.launches.length, 0);
        assert.equal(f.projection.subagents.length, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect(
  "rechecks the exact parent run at beforeLaunch and does not register a stale caller",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.beforeLaunch(() =>
        f.shell(liveThreadShell(threadId, { activeRunId: RunId.make("replacement-run") })),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "parent_not_active");
        assert.equal(f.projection.subagents.length, 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect(
  "remote mode=wait receives the persisted parent task result without subscribing to a remote child",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { ...input, mode: "wait" })
          .pipe(Effect.forkChild);
        const call = yield* Queue.take(f.calls);
        yield* Deferred.await(f.subscribed);
        yield* Deferred.succeed(call.reply, {
          threadId: remoteThreadId,
          reports: [],
          hasMore: false,
          latestRunId: remoteRunId,
          observedRun: { runId: remoteRunId, status: "completed", summary: "wait result" },
          timedOut: false,
        });
        const result = yield* Fiber.join(waiting);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "wait result");
        assert.equal(result.waitTimedOut, false);
        assert.equal(f.projection.subagents[0]?.completionWake, "settled_only");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("remote wait timeout upgrades completion delivery without cancelling the child", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const waiting = yield* service
        .delegateTask(scope, { ...input, mode: "wait", timeoutMs: 1_000 })
        .pipe(Effect.forkChild);
      const call = yield* Queue.take(f.calls);
      assert.equal(call.input.tool, "goat_origin_reports_wait");
      yield* Deferred.await(f.subscribed);
      yield* TestClock.adjust(1_000);
      const result = yield* Fiber.join(waiting);
      assert.equal(result.status, "running");
      assert.equal(result.waitTimedOut, true);
      assert.equal(f.projection.subagents[0]?.completionWake, "always");
      assert.equal(yield* Queue.size(f.calls), 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("cancellation accepted while launching is replayed before the first targeted wait", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.phase("after");
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const launch = yield* service.delegateTask(scope, input).pipe(Effect.forkChild);
      yield* Deferred.await(f.launchEntered);
      const task = f.projection.subagents[0]!;
      const result = yield* service.cancelTask(scope, { taskId: task.id });
      assert.equal(result.status, "cancel_requested");
      assert.equal(yield* Queue.size(f.calls), 0);
      assert.equal(task.status, "running");
      yield* Deferred.succeed(f.launchRelease, undefined);
      yield* Fiber.join(launch);
      const interrupt = yield* Queue.take(f.calls);
      assert.equal(interrupt.input.tool, "goat_thread_interrupt");
      assert.equal(interrupt.input.arguments.runId, remoteRunId);
      yield* Deferred.succeed(interrupt.reply, {
        host: "box",
        threadId: remoteThreadId,
        runId: remoteRunId,
        status: "interrupt_requested",
      });
      const read = yield* Queue.take(f.calls);
      assert.equal(read.input.arguments.watchRunId, remoteRunId);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect.each(["host_unavailable", "invalid_request", "host_unknown"] as const)(
  "retries the same clientRequestId after %s before registration",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.refuse(reason);
      f.failBeforeRegistration();
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const first = yield* service.delegateTask(scope, input).pipe(Effect.result);
        assert.equal(first._tag, "Failure");
        assert.equal(f.projection.subagents.length, 0);
        f.recoverLaunch();
        const retry = yield* service.delegateTask(scope, input);
        assert.equal(retry.status, "running");
        assert.equal(f.launches.length, 2);
        assert.equal(f.projection.subagents.length, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect.each(["remote_refused", "invalid_request", "caller_changed"] as const)(
  "reports that nothing was launched for definite %s after registration",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.refuse(reason);
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const handle = yield* service.delegateTask(scope, input);
        assert.equal(handle.status, "failed");
        assert.include(handle.summary ?? "", "nothing was launched");
        assert.notInclude(handle.summary ?? "", "outcome unknown");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("reports a later authority refusal as a definite unlaunched task", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.afterRegistration(() =>
      f.shell(liveThreadShell(threadId, { activeRunId: RunId.make("replacement") })),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const handle = yield* service.delegateTask(scope, input);
      assert.equal(handle.status, "failed");
      assert.include(handle.summary ?? "", "nothing was launched");
      assert.include(handle.summary ?? "", "parent_not_active");
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect.each(["lost", "settled"] as const)(
  "cancel publishes a failed result for an already %s dispatch with a running projection",
  (state) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const handle = yield* service.delegateTask(scope, input);
        yield* Queue.take(f.calls);
        yield* f.sql`UPDATE remote_dispatches SET state = ${state}`;
        const cancelled = yield* service.cancelTask(scope, { taskId: handle.taskId });
        assert.equal(cancelled.status, "failed");
        const status = yield* service.taskStatus(scope, handle.taskId);
        assert.equal(status.status, "failed");
        assert.include(status.summary ?? "", "thread or report binding is unavailable");
        assert.equal(yield* Queue.size(f.calls), 0);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

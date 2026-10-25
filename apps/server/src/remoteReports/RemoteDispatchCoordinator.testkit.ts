import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { assert } from "@effect/vitest";
import {
  ThreadId,
  NodeId,
  RunId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type RemoteReport,
  type RemoteOriginReportsWaitResult,
  type RemoteObservedRun,
  type RuntimeMode,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import Migration0062 from "../persistence/Migrations/070_RemoteReports.ts";
import Migration0063 from "../persistence/Migrations/071_RemoteDispatches.ts";
import Migration0065 from "../persistence/Migrations/073_RemoteDispatchQuestions.ts";
import Migration0068 from "../persistence/Migrations/075_RemoteReportRelay.ts";
import Migration0073 from "../persistence/Migrations/080_MemoryTaskGrantCeiling.ts";
import Migration0089 from "../persistence/Migrations/093_RemoteDispatchObservation.ts";
import Migration0101 from "../persistence/Migrations/102_RemoteReportInboxRunId.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";

export const origin = ThreadId.make("origin");
export const remote = ThreadId.make("remote");
export const runId = RunId.make("remote-run");
export const at = "2026-10-12T00:00:00.000Z";
export const report = (
  sequence: number,
  kind: RemoteReport["kind"] = "progress",
): RemoteReport => ({
  sequence,
  runId,
  kind,
  summary: `report-${sequence}`,
  createdAt: at,
});
export const answer = (
  reports: ReadonlyArray<RemoteReport>,
  status: RemoteObservedRun["status"] = "running",
  hasMore = false,
): RemoteOriginReportsWaitResult => ({
  threadId: remote,
  reports: [...reports],
  hasMore,
  timedOut: false,
  latestRunId: runId,
  observedRun: {
    runId,
    status,
    summary: status === "completed" ? "done" : null,
  },
});
export const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const migration of [Migration0062, Migration0063, Migration0065, Migration0068])
    yield* migration;
  yield* sql`CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY)`;
  for (const migration of [Migration0073, Migration0089, Migration0101]) yield* migration;
  const calls = yield* Queue.unbounded<{
    call: Ssh.SshHostToolCall;
    ceiling: RuntimeMode;
    reply: Queue.Queue<Effect.Effect<unknown, Ssh.SshRemoteDispatchError>>;
  }>();
  let latestReply: Queue.Queue<Effect.Effect<unknown, Ssh.SshRemoteDispatchError>> | undefined;
  const replyLatest = (effect: Effect.Effect<unknown, Ssh.SshRemoteDispatchError>) =>
    Effect.suspend(() =>
      latestReply === undefined ? Effect.die("No call") : Queue.offer(latestReply, effect),
    );
  const commits = yield* Queue.unbounded<void>();
  const parentLost = yield* Queue.unbounded<void>();
  const duplicateRead = yield* Queue.unbounded<void>();
  const failedImports = yield* Queue.unbounded<void>();
  const failedDeliveries = yield* Queue.unbounded<void>();
  const lost = yield* Queue.unbounded<void>();
  const attemptedCommands: OrchestrationV2ServerCommand[] = [];
  const recordedTasks: OrchestrationV2Subagent[] = [];
  const unavailableProjections = new Set<ThreadId>();
  const refusedTasks = new Set<NodeId>();
  const notifications = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const launchEntered = yield* Queue.unbounded<void>();
  const launchRelease = yield* Queue.unbounded<void>();
  const receipts = new Set<string>();
  const launches: Ssh.SshLaunchInput[] = [];
  const rearms: Array<Parameters<LaunchWatchService.LaunchWatchServiceShape["rearm"]>[0]> = [];
  let launchError: Ssh.SshRemoteDispatchError | undefined;
  const statements: string[] = [];
  let supported = true;
  let empty = false;
  let crashImport = false;
  let refuseReport = false;
  let deliveryFails = false;
  const refusedReviews = new Map<ThreadId, ThreadId>();
  let pauseLaunch = false;
  let pauseRegistration = false;
  let shell: OrchestrationV2ThreadShell | null = liveThreadShell(origin);
  const trackedSql = new Proxy(sql, {
    apply(target, thisArg, args) {
      const statement = Reflect.apply(target, thisArg, args);
      if (Array.isArray(args[0])) statements.push(args[0].join(""));
      if (
        Array.isArray(args[0]) &&
        args[0].join("").includes("state = 'lost', last_error = 'Remote task")
      )
        return statement.pipe(Effect.tap(() => Queue.offer(lost, undefined)));
      if (
        Array.isArray(args[0]) &&
        args[0].join("").includes("WHERE kind = 'task' AND origin_thread_id =")
      )
        return statement.pipe(Effect.tap(() => Queue.offer(duplicateRead, undefined)));
      return Array.isArray(args[0]) &&
        args[0].join("").includes("SET state = ") &&
        args.includes("Origin thread is unavailable.")
        ? statement.pipe(Effect.tap(() => Queue.offer(parentLost, undefined)))
        : statement;
    },
    get(target, key, receiver) {
      if (key !== "withTransaction") return Reflect.get(target, key, receiver);
      return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        target
          .withTransaction(
            Effect.gen(function* () {
              const value = yield* effect;
              if (crashImport) {
                yield* Queue.offer(failedImports, undefined);
                return yield* Effect.fail(
                  new Coordinator.RemoteDispatchError({ stage: "storage" }),
                );
              }
              return value;
            }),
          )
          .pipe(Effect.tap(() => Queue.offer(commits, undefined)));
    },
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, trackedSql),
    Layer.mock(LaunchWatchService.LaunchWatchService)({
      rearm: (input) => Effect.sync(() => void rearms.push(input)),
    }),
    Layer.mock(Ssh.SshRemoteDispatch)({
      connectedHosts: Effect.succeed(["box"]),
      launchThread: (input, check) =>
        Effect.gen(function* () {
          if (pauseRegistration) {
            yield* Queue.offer(launchEntered, undefined);
            yield* Queue.take(launchRelease);
          }
          yield* check;
          if (launchError !== undefined) return yield* launchError;
          launches.push(input);
          if (pauseLaunch) {
            yield* Queue.offer(launchEntered, undefined);
            yield* Queue.take(launchRelease);
          }
          if (refuseReport && input.report !== undefined)
            return yield* new Ssh.SshRemoteDispatchError({
              reason: "remote_refused",
              message:
                "The remote goat_thread_launch refused: goat_thread_launch does not take report, so nothing ran. It takes projectId, title, message, workspace, runtimeMode.",
            });
          return {
            host: "box",
            cwd: "/fixture",
            projectId: "project",
            projectCreated: false,
            threadId: remote,
            runId: empty ? null : runId,
            reportsSupported: supported,
            workspaceStrategy: { type: "root" },
            runtimeMode: input.runtimeMode,
            remoteServerKind: null,
            notes: [],
          } satisfies Ssh.SshLaunchResult;
        }),
      callHostTool: (call, authorize) =>
        Effect.gen(function* () {
          const ceiling = yield* authorize;
          const reply =
            yield* Queue.unbounded<Effect.Effect<unknown, Ssh.SshRemoteDispatchError>>();
          latestReply = reply;
          yield* Queue.offer(calls, { call, ceiling, reply });
          return yield* yield* Queue.take(reply);
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      assertReviewTaskSendAllowed: (input) => {
        const owner = refusedReviews.get(input.threadId);
        if (owner === undefined) return Effect.void;
        assert.equal(input.senderThreadId, owner);
        return Effect.fail(
          new Threads.ThreadManagementReviewTaskFinishedError({ threadId: input.threadId }),
        );
      },
      getThreadRecords: (id) =>
        unavailableProjections.has(id)
          ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id }))
          : Effect.succeed({
              ...idleThreadProjection(liveThreadShell(id)),
              subagents: recordedTasks,
            }),
      getThreadShell: () => Effect.succeed(shell),
      dispatch: (command) =>
        Effect.gen(function* () {
          attemptedCommands.push(command);
          if (
            deliveryFails ||
            (command.type === "delegated_task.remote.result" && refusedTasks.has(command.taskId))
          ) {
            yield* Queue.offer(failedDeliveries, undefined);
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "fixture delivery refusal",
            });
          }
          if (!receipts.has(command.commandId)) {
            receipts.add(command.commandId);
            yield* Queue.offer(notifications, command);
          }
          return { sequence: receipts.size, storedEvents: [] };
        }),
    }),
  );
  const layer = Coordinator.layer.pipe(Layer.provide(dependencies));
  const launch = (
    c: Coordinator.RemoteDispatchCoordinator["Service"],
    delivery: "wake" | "next_turn" | "notify_only" = "wake",
    message: string | undefined = "work",
    memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling,
  ) =>
    c.launch(
      {
        kind: "thread",
        originThreadId: origin,
        delivery,
        launch: {
          host: "box",
          cwd: "/fixture",
          workspace: { type: "cwd" },
          title: "fixture",
          message,
          ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
          runtimeMode: "full-access",
          callerRuntimeMode: "full-access",
        },
      },
      Effect.void,
    );
  return {
    sql,
    statements,
    launchError: (value: Ssh.SshRemoteDispatchError) => {
      launchError = value;
    },
    lost,
    attemptedCommands,
    refusedReviews,
    recordedTasks,
    unavailableProjections,
    refusedTasks,
    layer,
    launch,
    calls,
    replyLatest,
    commits,
    parentLost,
    duplicateRead,
    failedImports,
    notifications,
    launches,
    rearms,
    failedDeliveries,
    launchEntered,
    launchRelease,
    shell: (value: OrchestrationV2ThreadShell | null) => {
      shell = value;
    },
    pauseRegistration: () => {
      pauseRegistration = true;
    },
    pauseLaunch: () => {
      pauseLaunch = true;
    },
    refuse: (value: boolean) => {
      refuseReport = value;
    },
    failDelivery: (value: boolean) => {
      deliveryFails = value;
    },
    supported: (value: boolean) => {
      supported = value;
    },
    empty: (value: boolean) => {
      empty = value;
    },
    crash: (value: boolean) => {
      crashImport = value;
    },
  };
});
export const database = NodeSqliteClient.layer({ filename: ":memory:" });

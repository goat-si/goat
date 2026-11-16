import { database, fixture, origin, remote } from "./RemoteDispatchCoordinator.testkit.ts";
import { assert, it } from "@effect/vitest";
import { derive } from "@goat/provider-core/server/IdAllocator";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { followUpCorrelationId } from "./remoteTaskFollowUp.ts";

const parentRunId = RunId.make("origin-run");
const followUpRunId = RunId.make("remote-run-2");
const instanceId = ProviderInstanceId.make("codex");

const seedFinishedTask = (f: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const run: OrchestrationV2Run = {
      id: parentRunId,
      threadId: origin,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make("origin-message"),
      rootNodeId: NodeId.make("origin-root"),
      activeAttemptId: null,
      // The parent's turn ended while a background agent of its own still holds its credential.
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const task: OrchestrationV2Subagent = {
      id: NodeId.make("first-task"),
      threadId: origin,
      runId: parentRunId,
      parentNodeId: NodeId.make("origin-root"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      remote: { host: "box", threadId: remote, correlationId: "rr-first" },
      prompt: "Run the tests.",
      title: "Tests",
      model: "gpt-5",
      completionWake: "always",
      status: "completed",
      result: "All green.",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    f.recordedRuns.push(run);
    f.recordedTasks.push(task);
  });

const sent = (delivery: "started" | "queued" | "steered", messageId = "message-2") =>
  ({
    host: "box",
    threadId: remote,
    messageId: MessageId.make(messageId),
    runId: followUpRunId,
    status: "running",
    delivery,
  }) as const;

const followUp = (c: Coordinator.RemoteDispatchCoordinator["Service"], value = sent("started")) =>
  c.followUp({
    originThreadId: origin,
    host: "box",
    request: { message: "Now run the slow suite too." },
    sent: value,
  });

const registered = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command) =>
    command.type === "delegated_task.remote.register" ? [command] : [],
  );

it.effect("a follow-up to a finished remote task is a new task that wakes its parent", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      yield* seedFinishedTask(f);
      const result = yield* followUp(c);
      assert.isTrue("taskId" in result && result.taskId !== undefined);
      const [register] = registered(f.attemptedCommands);
      assert.equal(register?.parentRunId, parentRunId);
      assert.equal(register?.completionWake, "always");
      assert.equal(register?.task, "Now run the slow suite too.");
      assert.deepEqual(register?.remote.threadId, remote);
      const taskId = "taskId" in result ? result.taskId : undefined;
      assert.equal(taskId, register && derive.delegatedTaskNode({ commandId: register.commandId }));

      // Its own run there is followed, not the run the first task waited on.
      const wait = yield* Queue.take(f.calls);
      assert.equal(wait.call.tool, "goat_thread_wait");
      assert.deepEqual(wait.call.arguments, {
        threadId: remote,
        runId: followUpRunId,
        timeoutMs: 300_000,
      });
      yield* Queue.offer(
        wait.reply,
        Effect.succeed({
          host: "box",
          threadId: remote,
          runId: followUpRunId,
          status: "completed",
          timedOut: false,
          result: {
            runId: followUpRunId,
            runStatus: "completed",
            outcome: "succeeded",
            reportedAt: null,
            summary: "The slow suite passes too.",
            pullRequests: [],
            commits: [],
            branch: null,
          },
        }),
      );
      const recorded = yield* Effect.gen(function* () {
        while (true) {
          const command = yield* Queue.take(f.notifications);
          if (command.type === "delegated_task.remote.result") return command;
        }
      });
      assert.equal(recorded.taskId, taskId);
      assert.equal(recorded.status, "completed");
      assert.equal(recorded.summary, "The slow suite passes too.");
      // The first task keeps its result; only the follow-up's record settles.
      assert.notEqual(recorded.taskId, NodeId.make("first-task"));
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect.each(["running", "settled"] as const)(
  "a retried follow-up send whose task is recorded returns that task, its row %s",
  (state) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        yield* seedFinishedTask(f);
        const first = yield* followUp(c);
        const [register] = registered(f.attemptedCommands);
        const taskId = register && derive.delegatedTaskNode({ commandId: register.commandId });
        const finished = f.recordedTasks[0];
        if (taskId === undefined || finished === undefined) return assert.fail("no task");
        f.recordedTasks.push({ ...finished, id: taskId, status: "running", result: null });
        yield* f.sql`UPDATE remote_dispatches SET state = ${state} WHERE task_id = ${taskId}`;
        const again = yield* followUp(c);
        assert.deepEqual(again, first);
        assert.lengthOf(registered(f.attemptedCommands), 1);
        assert.lengthOf(yield* f.sql`SELECT task_id FROM remote_dispatches WHERE kind = 'task'`, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

/** The row a crash between the INSERT and the registration leaves behind. */
const orphanRow = (f: Effect.Success<typeof fixture>, state: "running" | "settled") =>
  Effect.gen(function* () {
    const correlationId = followUpCorrelationId(origin, "box", MessageId.make("message-2"));
    const commandId = CommandId.make(`remote-task-follow-up:${correlationId}`);
    const taskId = derive.delegatedTaskNode({ commandId });
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* f.sql`INSERT INTO remote_dispatches
      (correlation_id, kind, origin_thread_id, host, remote_thread_id, launched_run_id, read_key,
        delivery, reports_supported, state, task_id, parent_run_id, relay_send, created_at, updated_at)
      VALUES (${correlationId}, 'task', ${origin}, 'box', ${remote}, ${followUpRunId}, 'key',
        'wake', 0, ${state}, ${taskId}, ${parentRunId}, 0, ${at}, ${at})`;
    return taskId;
  });

it.effect(
  "a retry after a crash before registration registers once and wakes the parent once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        yield* seedFinishedTask(f);
        const taskId = yield* orphanRow(f, "running");
        const result = yield* followUp(c);
        assert.equal("taskId" in result ? result.taskId : undefined, taskId);
        assert.lengthOf(registered(f.attemptedCommands), 1);
        const wait = yield* Queue.take(f.calls);
        yield* Queue.offer(
          wait.reply,
          Effect.succeed({
            host: "box",
            threadId: remote,
            runId: followUpRunId,
            status: "completed",
            timedOut: false,
          }),
        );
        while ((yield* Queue.take(f.notifications)).type !== "delegated_task.remote.result");
        const results = f.attemptedCommands.filter(
          (command) => command.type === "delegated_task.remote.result",
        );
        assert.lengthOf(results, 1);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);

it.effect("a retry after the orphan row settled says the task was not recorded", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      yield* seedFinishedTask(f);
      yield* orphanRow(f, "settled");
      const refused = yield* Effect.flip(followUp(c));
      assert.include(refused.message, "The message was sent, but its task was not recorded");
      // Never a task that waits on a row nothing follows any more.
      assert.lengthOf(registered(f.attemptedCommands), 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a steer, or a send to a thread with no finished task, records no task", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      // No finished task of the caller runs on that thread yet.
      assert.deepEqual(yield* followUp(c), sent("started"));
      yield* seedFinishedTask(f);
      // A steer joins a run that is already some task's, or no one's.
      assert.deepEqual(yield* followUp(c, sent("steered")), sent("steered"));
      assert.lengthOf(registered(f.attemptedCommands), 0);
      assert.lengthOf(yield* f.sql`SELECT correlation_id FROM remote_dispatches`, 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a follow-up whose task is refused leaves no dispatch record and says so", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      yield* seedFinishedTask(f);
      f.refusedCommandTypes.add("delegated_task.remote.register");
      const refused = yield* Effect.flip(followUp(c));
      assert.include(refused.message, "The message was sent, but its task was not recorded");
      assert.lengthOf(yield* f.sql`SELECT correlation_id FROM remote_dispatches`, 0);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

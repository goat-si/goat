import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type ChannelTask,
  type OrchestrationV2Subagent,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelBotMembers from "./ChannelBotMembers.ts";
import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { childWorkIdFor, workerLaunchIdsFor } from "./channelIds.ts";
import { makeTaskRetry } from "./channelTaskRetry.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { nextTaskChange, watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  goatInput,
  makeHarness,
  onlyTask,
  owner,
  ownerId,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const START = Date.parse("2026-10-12T00:00:00.000Z");

/** One person's request, started and then failed by its worker. */
const failedTask = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(goatInput("do: tidy the docs", "retry-1"), rpcContext);
    yield* runtime.drain;
    const started = yield* onlyTask;
    const threadId = started.worker!.threadId;
    harness.world.setStatus(threadId, 1, "failed");
    yield* runtime.drain;
    const task = yield* onlyTask;
    assert.strictEqual(task.status, "failed");
    return { task, threadId, runtime };
  });

const retry = (task: ChannelTask, clientRequestId: string, who = owner) =>
  Effect.gen(function* () {
    const threads = yield* BotThreads.ChannelBotThreads;
    return yield* threads.retry({ taskId: task.taskId, clientRequestId }, who);
  });

/**
 * A retry whose first look at a worker thread waits for release: it has read the task by then,
 * so a test can commit another retry in between and see what the late one does.
 */
const pausedRetry = Effect.gen(function* () {
  const real = yield* ThreadManagement.ThreadManagementService;
  const reading = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let paused = false;
  const getThreadRecords = ((...args: Parameters<typeof real.getThreadRecords>) => {
    if (paused) return real.getThreadRecords(...args);
    paused = true;
    return Deferred.succeed(reading, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(real.getThreadRecords(...args)),
    );
  }) as typeof real.getThreadRecords;
  const retry = yield* makeTaskRetry.pipe(
    Effect.provideService(ThreadManagement.ThreadManagementService, {
      ...real,
      getThreadRecords,
    }),
  );
  return { retry, reading, release };
});

const refusalOf = (result: { readonly status: string; readonly reason?: string }) =>
  result.status === "refused" ? result.reason : result.status;

const liveSubagent = (childThreadId: string) =>
  ({
    childThreadId: ThreadId.make(childThreadId),
    status: "running",
    origin: "app_owned",
  }) as unknown as OrchestrationV2Subagent;

describe("a person retries a GOAT Bot task", () => {
  it.effect(
    "a failed task runs once more as attempt 2, and a resent tap starts nothing new",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, runtime } = yield* failedTask(harness);
        const first = yield* retry(task, "tap-1");
        assert.deepStrictEqual(first, { status: "started", taskId: task.taskId, generation: 2 });
        yield* runtime.drain;
        assert.strictEqual(harness.world.launches.length, 2);
        assert.strictEqual(
          harness.world.launches[1]?.threadId,
          workerLaunchIdsFor(task.taskId, 2).threadId,
        );
        const again = yield* retry(task, "tap-1");
        assert.deepStrictEqual(again, first);
        yield* runtime.drain;
        yield* runtime.drain;
        assert.strictEqual(harness.world.launches.length, 2);
        const current = yield* onlyTask;
        assert.strictEqual(current.generation, 2);
        assert.strictEqual(current.status, "running");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a tap that read the task before another retry committed judges the new attempt",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task, runtime } = yield* failedTask(harness);
        const late = yield* pausedRetry;
        const lateTap = yield* Effect.forkChild(
          late.retry({ taskId: task.taskId, clientRequestId: "tap-late" }, owner),
        );
        // The late tap has read attempt 1 as failed and is checking its old worker.
        yield* Deferred.await(late.reading);
        assert.strictEqual(refusalOf(yield* retry(task, "tap-first")), "started");
        yield* runtime.drain;
        const secondThread = workerLaunchIdsFor(task.taskId, 2).threadId;
        harness.world.setStatus(secondThread, 1, "failed");
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "failed");
        // Attempt 2 failed, but its worker still has a subagent running.
        harness.world.subagents.set(secondThread, [liveSubagent("thread:second-child")]);
        yield* Deferred.succeed(late.release, undefined);
        assert.strictEqual(refusalOf(yield* Fiber.join(lateTap)), "still_running");
        assert.strictEqual((yield* onlyTask).generation, 2);
        yield* runtime.drain;
        assert.strictEqual(harness.world.launches.length, 2);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("the same tap racing itself starts one attempt and both answers name it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, runtime } = yield* failedTask(harness);
      const late = yield* pausedRetry;
      const lateTap = yield* Effect.forkChild(
        late.retry({ taskId: task.taskId, clientRequestId: "tap-same" }, owner),
      );
      yield* Deferred.await(late.reading);
      const first = yield* retry(task, "tap-same");
      yield* Deferred.succeed(late.release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(lateTap), first);
      assert.deepStrictEqual(first, { status: "started", taskId: task.taskId, generation: 2 });
      const sql = yield* SqlClient.SqlClient;
      const retries = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM channel_task_events WHERE task_id = ${task.taskId} AND type = 'task.retry.requested'`;
      assert.strictEqual(retries[0]?.count, 1);
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a resent tap is checked again: another owner or a lowered ceiling learns nothing",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task } = yield* failedTask(harness);
        yield* retry(task, "tap-1");
        const stranger = yield* Effect.flip(
          retry(task, "tap-1", { ...owner, ownerId: "environment:someone-else" }),
        );
        assert.strictEqual(stranger.reason, "task_not_found");
        const lowered = yield* Effect.flip(
          retry(task, "tap-1", { ...owner, runtimeModeCeiling: "approval-required" }),
        );
        assert.strictEqual(lowered.reason, "forbidden");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses callers who could not stop the work, and writes nothing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task } = yield* failedTask(harness);
      const reader = yield* Effect.flip(
        retry(task, "tap-1", { ...owner, grantedScopes: ["orchestration:read"] }),
      );
      assert.strictEqual(reader.reason, "forbidden");
      const lower = yield* Effect.flip(
        retry(task, "tap-2", { ...owner, runtimeModeCeiling: "approval-required" }),
      );
      assert.strictEqual(lower.reason, "forbidden");
      const other = yield* Effect.flip(
        retry(task, "tap-3", { ...owner, ownerId: "environment:someone-else" }),
      );
      assert.strictEqual(other.reason, "task_not_found");
      const after = yield* onlyTask;
      assert.strictEqual(after.version, task.version);
      assert.strictEqual(after.status, "failed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("waits for a stop to finish before running a stopped task again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* gateway.ingest(goatInput("do: tidy the docs", "retry-stop"), rpcContext);
      yield* runtime.drain;
      const running = yield* ledger.getTask((yield* onlyTask).taskId);
      yield* commitTransition(
        ledger,
        running!,
        { type: "task.cancelled", payload: { reason: "Stopped by Owner." } },
        { actor: "user", forward: true },
      );
      const cancelled = yield* onlyTask;
      assert.strictEqual(refusalOf(yield* retry(cancelled, "tap-early")), "still_running");
      yield* runtime.drain;
      assert.strictEqual(refusalOf(yield* retry(cancelled, "tap-later")), "started");
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses while the old worker still has a subagent, background or cloud work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId } = yield* failedTask(harness);
      harness.world.subagents.set(threadId, [liveSubagent("thread:child")]);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "still_running");
      harness.world.subagents.delete(threadId);
      harness.world.cloudTasks.set(threadId, "running");
      assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "still_running");
      harness.world.cloudTasks.delete(threadId);
      harness.world.background.add(threadId);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-background")), "still_running");
      harness.world.background.delete(threadId);
      harness.world.recordFailures.add(threadId);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-3")), "still_running");
      harness.world.recordFailures.delete(threadId);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-4")), "started");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses while child work of the failed attempt is still running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      yield* gateway.ingest(goatInput("do: tidy the docs", "retry-child"), rpcContext);
      yield* runtime.drain;
      const threadId = (yield* onlyTask).worker!.threadId;
      const admitted = yield* childWork.admit({
        callerThreadId: threadId,
        surface: "thread_launch",
        prompt: "Check the links.",
        destinationKey: "local",
      });
      assert.strictEqual(admitted._tag, "admitted");
      if (admitted._tag !== "admitted") return;
      const child = ThreadId.make("thread:retry-child");
      harness.world.addRun(child, MessageId.make("child-message"));
      yield* childWork.markBound(admitted.record, { threadId: child });
      harness.world.setStatus(threadId, 1, "failed");
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.status, "failed");
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "still_running");
      harness.world.setStatus(child, 1, "completed");
      yield* runtime.drain;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "started");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the retired worker launches nothing more and an old admission is fenced out", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, threadId } = yield* failedTask(harness);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "started");
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const late = yield* Effect.flip(
        childWork.admit({
          callerThreadId: threadId,
          surface: "thread_launch",
          prompt: "Check the links.",
          destinationKey: "local",
        }),
      );
      assert.strictEqual(late.reason, "owner_terminal");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const stale = yield* store.admitReserved(
        {
          childWorkId: childWorkIdFor(task.taskId, 1, "stale"),
          ownerId,
          taskId: task.taskId,
          generation: 1,
          surface: "thread_launch",
          callerThreadId: threadId,
          requestKey: "stale",
          promptDigest: "digest",
          state: "reserved",
          createdAt: "2026-10-12T00:00:00.000Z",
          updatedAt: "2026-10-12T00:00:00.000Z",
        },
        4,
      );
      assert.strictEqual(stale._tag, "owner_settled");
      assert.deepStrictEqual(yield* store.listForTask(task.taskId), []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a launch that made its thread and then failed waits for that thread to end", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* setupBot;
      harness.world.failLaunchAfterAccept = true;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: tidy the docs", "retry-launch"), rpcContext);
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.strictEqual(task.status, "failed");
      assert.isUndefined(task.worker);
      harness.world.failLaunchAfterAccept = false;
      const threadId = workerLaunchIdsFor(task.taskId, 1).threadId;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "still_running");
      harness.world.setStatus(threadId, 1, "completed");
      assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "started");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a claimed task that failed before any thread exists waits out the launch grace",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { task: first } = yield* failedTask(harness);
        const sql = yield* SqlClient.SqlClient;
        // The same task, as if its launch never made a thread: no worker and no thread to read.
        yield* sql`UPDATE channel_tasks SET worker_thread_id = NULL,
        task_json = json_remove(task_json, '$.worker') WHERE task_id = ${first.taskId}`;
        harness.world.runs.delete(workerLaunchIdsFor(first.taskId, 1).threadId);
        const task = yield* onlyTask;
        assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "still_running");
        yield* TestClock.adjust("121 seconds");
        assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "started");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses work that is running or finished, and a GOAT Bot turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("do: tidy the docs", "retry-states"), rpcContext);
      yield* runtime.drain;
      const running = yield* onlyTask;
      assert.strictEqual(refusalOf(yield* retry(running, "tap-1")), "not_finished");
      harness.world.setStatus(running.worker!.threadId, 1, "completed", "Done.");
      yield* runtime.drain;
      const completed = yield* onlyTask;
      assert.strictEqual(completed.status, "completed");
      assert.strictEqual(refusalOf(yield* retry(completed, "tap-2")), "completed");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.kind', 'turn')
        WHERE task_id = ${completed.taskId}`;
      const turn = yield* Effect.flip(retry(completed, "tap-3"));
      assert.strictEqual(turn.reason, "task_not_found");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses work that ran, was placed, or moved from another machine", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, runtime } = yield* failedTask(harness);
      const sql = yield* SqlClient.SqlClient;
      const snapshot = (yield* sql<{ readonly task_json: string }>`
        SELECT task_json FROM channel_tasks WHERE task_id = ${task.taskId}`)[0]!.task_json;
      const restore = sql`UPDATE channel_tasks SET task_json = ${snapshot} WHERE task_id = ${task.taskId}`;
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.host', 'build-box')
        WHERE task_id = ${task.taskId}`;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "elsewhere");
      yield* restore;
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.movedFrom',
        json('{"host":"build-box","generation":1,"at":"2026-10-12T00:00:00.000Z","replicaCapturedAt":"2026-10-12T00:00:00.000Z"}'))
        WHERE task_id = ${task.taskId}`;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "elsewhere");
      yield* restore;
      // Only the history remembers the earlier machine.
      const moved = JSON.stringify({
        eventId: "moved-earlier",
        sequence: 0,
        taskId: task.taskId,
        taskVersion: 999,
        occurredAt: "2026-10-12T00:00:00.000Z",
        actor: "system",
        type: "task.moved",
        payload: {
          generation: 1,
          host: "this-machine",
          fromHost: "build-box",
          replicaCapturedAt: "2026-10-12T00:00:00.000Z",
        },
      });
      yield* sql`INSERT INTO channel_task_events (event_id, task_id, task_version, type, event_json, occurred_at)
        VALUES ('moved-earlier', ${task.taskId}, 999, 'task.moved', ${moved}, '2026-10-12T00:00:00.000Z')`;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-3")), "elsewhere");
      yield* runtime.drain;
      assert.strictEqual(harness.world.launches.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a member bot's task retries the same way, and not once the member is deleted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task } = yield* failedTask(harness);
      const members = yield* ChannelBotMembers.ChannelBotMembers;
      const member = yield* members.create(
        {
          clientRequestId: "member-1",
          name: "Helper",
          avatar: null,
          purpose: "Checks builds.",
          defaultModelSelection: null,
        },
        owner,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_tasks SET bot_id = ${member.botId} WHERE task_id = ${task.taskId}`;
      yield* members.remove({ botId: member.botId }, owner);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "bot_inactive");
      yield* members.restore({ botId: member.botId }, owner);
      assert.strictEqual(refusalOf(yield* retry(task, "tap-2")), "started");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clears the failed attempt's pending answer and completion hold", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task } = yield* failedTask(harness);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_tasks SET pending_answer_message_id = 'answer-1',
        completion_hold = 'hold-1' WHERE task_id = ${task.taskId}`;
      assert.strictEqual(refusalOf(yield* retry(task, "tap-1")), "started");
      const row = (yield* sql<{
        readonly pending_answer_message_id: string | null;
        readonly completion_hold: string | null;
      }>`SELECT pending_answer_message_id, completion_hold FROM channel_tasks
        WHERE task_id = ${task.taskId}`)[0];
      assert.deepStrictEqual(row, { pending_answer_message_id: null, completion_hold: null });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the export counts the rerun on the second outcome", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, runtime } = yield* failedTask(harness);
      yield* retry(task, "tap-1");
      yield* runtime.drain;
      harness.world.setStatus(workerLaunchIdsFor(task.taskId, 2).threadId, 1, "failed");
      yield* runtime.drain;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const page = yield* ledger.exportTasks({
        ownerId,
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-11-01T00:00:00.000Z",
      });
      const lines = page.jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { reruns: number; generation: number });
      assert.deepStrictEqual(
        lines.map(({ reruns, generation }) => ({ reruns, generation })),
        [
          { reruns: 0, generation: 1 },
          { reruns: 1, generation: 2 },
        ],
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("telling a mounted list that a retry started", () => {
  it.effect("a retry gives its owner a revision once its own transaction committed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task } = yield* failedTask(harness);
      const seen = yield* watchTaskChanges(owner);
      assert.strictEqual((yield* retry(task, "tap-changes")).status, "started");
      assert.strictEqual(yield* nextTaskChange(seen), 1);
    }).pipe(Effect.provide(harness.layer));
  });
});

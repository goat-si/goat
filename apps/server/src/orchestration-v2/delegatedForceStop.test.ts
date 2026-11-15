import { assert, it } from "@effect/vitest";
import { NodeId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  interruptResult,
  parentWithTask,
  refusal,
  runStatuses,
  stopRequested,
  updateChildProviderThread,
  updateTask,
} from "./delegatedForceStop.testkit.ts";
import {
  adapter,
  createWatchingThread,
  delegate,
  layerForAdapter,
  layerTest,
  send,
} from "./ThreadStop.testkit.ts";

it.effect("the parent's Force stop ends its task's child after Stop went unanswered", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-ok",
      "unanswered",
    );
    const forced = yield* threads.forceStopDelegatedTask({ parentThreadId, taskId });
    assert.equal(forced.childThreadId, childThreadId);
    assert.deepEqual(yield* runStatuses(childThreadId), ["interrupted"]);
    const result = (yield* orchestrator.getThreadProjection(childThreadId)).turnItems.find(
      (item) => item.type === "run_interrupt_result",
    );
    // The child's timeline names who force stopped it by title, never by raw id.
    assert.equal(
      result?.type === "run_interrupt_result" ? result.message : undefined,
      'Force stopped by parent thread "force-ok parent"',
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a first Force stop, before any Stop timed out, refuses and stops nothing", () =>
  Effect.gen(function* () {
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-early",
      "requested",
    );
    assert.equal(yield* refusal({ parentThreadId, taskId }), "not_unresponsive");
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("only the thread that created the task can force stop it", () =>
  Effect.gen(function* () {
    const { childThreadId, taskId } = yield* parentWithTask("force-owner", "unanswered");
    // Another parent's task, and a top-level thread that no task of this thread names.
    const other = yield* parentWithTask("force-other", "unanswered");
    assert.equal(yield* refusal({ parentThreadId: other.parentThreadId, taskId }), "not_owner");
    assert.equal(
      yield* refusal({
        parentThreadId: other.parentThreadId,
        taskId: NodeId.make(String(childThreadId)),
      }),
      "not_owner",
    );
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a grandchild is not its grandparent's to force stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId } = yield* parentWithTask("force-grand", "none");
    const grandchildThreadId = yield* delegate(childThreadId, "force-grand nested");
    yield* stopRequested(grandchildThreadId, true);
    const grandTaskId = (yield* orchestrator.getThreadProjection(childThreadId)).subagents.find(
      (task) => task.childThreadId === grandchildThreadId,
    )!.id;
    assert.equal(yield* refusal({ parentThreadId, taskId: grandTaskId }), "not_owner");
    assert.deepEqual(yield* runStatuses(grandchildThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "a child the person promoted to a top-level thread", promoted: true },
  { name: "a provider-native subagent", promoted: false },
])("$name is not its parent's to force stop, even after Stop went unanswered", (row) =>
  Effect.gen(function* () {
    const task = yield* parentWithTask(`force-unowned-${row.promoted}`, "unanswered");
    yield* updateTask(task.parentThreadId, task.taskId, (record, now) =>
      row.promoted ? { ...record, promotedAt: now } : { ...record, origin: "provider_native" },
    );
    assert.equal(yield* refusal(task), "not_owner");
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Force stop after a server restart ends the child, and the decision survives the next",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = Layer.succeedContext(yield* Layer.build(SqlitePersistence.layerMemory));
        // Each provide builds new services over the same storage, as a restarted server does.
        const server = layerForAdapter(adapter, { database });
        const task = yield* parentWithTask("force-restart", "unanswered").pipe(
          Effect.provide(server),
        );
        const forced = yield* ThreadManagementService.ThreadManagementService.use((threads) =>
          threads.forceStopDelegatedTask(task),
        ).pipe(Effect.provide(server));
        assert.equal(forced.childThreadId, task.childThreadId);
        const after = yield* Effect.all({
          runs: runStatuses(task.childThreadId),
          reason: interruptResult(task.childThreadId),
          again: refusal(task),
        }).pipe(Effect.provide(server));
        assert.deepEqual(after, {
          runs: ["interrupted"],
          reason: 'Force stopped by parent thread "force-restart parent"',
          again: "not_unresponsive",
        });
      }),
    ),
);

it.effect("the parent's Force stop of a cloud child refuses and leaves its run alone", () =>
  Effect.gen(function* () {
    const task = yield* parentWithTask("force-cloud", "unanswered");
    yield* updateChildProviderThread(task.childThreadId, (thread, now) => ({
      ...thread,
      cloudTask: {
        taskId: "cloud-task-1",
        status: "running",
        tracking: "polled",
        source: { repository: "goat-si/goat", branch: "dev" },
        localChangesExcluded: false,
        updatedAt: DateTime.formatIso(now),
      },
    }));
    assert.equal(yield* refusal(task), "cloud");
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the parent's Force stop detaches a child session another working thread shares", () => {
  const calls: Array<string> = [];
  const sibling = ThreadId.make("thread:force-shared-sibling");
  const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    isLive: () => Effect.succeed(true),
    otherWorkingThreads: () => Effect.succeed([sibling]),
    detach: () => Effect.sync(() => calls.push("detach")),
    releaseUnlessBusy: () => Effect.sync(() => calls.push("release")).pipe(Effect.as(true)),
  });
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* createWatchingThread(sibling, 41);
    yield* send(sibling, "sibling work", "start_immediately");
    const siblingRuns = yield* runStatuses(sibling);
    const task = yield* parentWithTask("force-shared", "unanswered");
    yield* updateChildProviderThread(task.childThreadId, (thread) => ({
      ...thread,
      providerSessionId: ProviderSessionId.make("provider-session:force-shared"),
    }));
    const forced = yield* threads.forceStopDelegatedTask(task);
    assert.deepEqual(
      { outcome: forced.outcome, sharedWith: forced.sharedWithThreadIds, calls },
      { outcome: "shared", sharedWith: [sibling], calls: ["detach"] },
    );
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["interrupted"]);
    assert.deepEqual(yield* runStatuses(sibling), siblingRuns);
  }).pipe(Effect.provide(layerForAdapter(adapter, { sessions })));
});

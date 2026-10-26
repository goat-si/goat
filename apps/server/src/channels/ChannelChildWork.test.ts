import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { childWorkCorrelationIdFor, taskEventIdFor } from "./channelIds.ts";
import {
  admit,
  childThread,
  type DispatchedStop,
  fakeRun,
  isChildWorkError,
  makeLayer,
  move,
  NOW,
  seedWorker,
} from "./testkit/channelChildWorkFixture.ts";

describe("ChannelChildWork admission", () => {
  it.effect("a caller outside channel work is never recorded", () =>
    Effect.gen(function* () {
      const admission = yield* admit("hello", { callerThreadId: ThreadId.make("stranger") });
      assert.strictEqual(admission._tag, "not_channel_owned");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const taskId = yield* seedWorker;
      assert.deepStrictEqual(yield* store.listForTask(taskId), []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("admits up to the descendant budget, then refuses at capacity", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      for (let i = 1; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE; i += 1) {
        const admitted = yield* admit("delegate-" + i);
        assert.strictEqual(admitted._tag, "admitted");
      }
      const overflow = yield* Effect.flip(admit("delegate-overflow"));
      assert.strictEqual(overflow.reason, "at_capacity");
      // Thread launches use their own capacity bucket, so 4 threads still fit while delegates are full.
      for (let i = 1; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE_THREADS; i += 1) {
        const threadAdmitted = yield* admit("thread-" + i, { surface: "thread_launch" });
        assert.strictEqual(threadAdmitted._tag, "admitted");
      }
      const threadOverflow = yield* Effect.flip(
        admit("thread-overflow", { surface: "thread_launch" }),
      );
      assert.strictEqual(threadOverflow.reason, "at_capacity");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.listForTask(taskId)).length,
        ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE +
          ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE_THREADS,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("serializes racing admissions so the budget cannot be overrun", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const keys = Array.from(
        { length: ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE + 2 },
        (_, index) => String(index),
      );
      const outcomes = yield* Effect.forEach(
        keys,
        (key) => Effect.result(admit("concurrent " + key)),
        { concurrency: keys.length },
      );
      const admitted = outcomes.filter((outcome) => outcome._tag === "Success");
      const refused = outcomes.filter(
        (outcome) =>
          outcome._tag === "Failure" &&
          isChildWorkError(outcome.failure) &&
          outcome.failure.reason === "at_capacity",
      );
      assert.strictEqual(admitted.length, ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE);
      assert.strictEqual(refused.length, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("returns capacity when a descendant settles, so a coordinator never deadlocks", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("one");
      assert.strictEqual(first._tag, "admitted");
      for (let i = 2; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE; i += 1) {
        assert.strictEqual((yield* admit("slot-" + i))._tag, "admitted");
      }
      if (first._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(first.record, { threadId: childThread }));
      yield* childWork.markTerminal(first.record, "completed");
      const next = yield* admit("after-settle");
      assert.strictEqual(next._tag, "admitted");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a recorded child cannot admit its own descendant", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("delegate");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      const nested = yield* Effect.flip(admit("nested", { callerThreadId: childThread }));
      assert.strictEqual(nested.reason, "depth_exceeded");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a keyless retry reuses its record instead of reserving twice", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const first = yield* admit("same request");
      const retry = yield* admit("same request");
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(retry._tag, "existing");
      if (first._tag === "not_channel_owned" || retry._tag === "not_channel_owned")
        return yield* Effect.die("expected ownership");
      assert.strictEqual(retry.record.childWorkId, first.record.childWorkId);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.listForTask(taskId)).length, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a stable clientRequestId anchors the retry; a new one is a new request", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const first = yield* admit("keyed", { clientRequestId: "req-1" });
      const retry = yield* admit("keyed", { clientRequestId: "req-1" });
      assert.strictEqual(first._tag, "admitted");
      assert.strictEqual(retry._tag, "existing");
      const distinct = yield* admit("keyed", { clientRequestId: "req-2" });
      assert.strictEqual(distinct._tag, "admitted");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.listForTask(taskId)).length, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("releaseReserved frees a reservation but never settles launched work", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("reserved one");
      const second = yield* admit("reserved two");
      if (first._tag !== "admitted" || second._tag !== "admitted")
        return yield* Effect.die("expected admissions");
      for (let i = 3; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE; i += 1) {
        assert.strictEqual((yield* admit("reserved-" + i))._tag, "admitted");
      }
      yield* childWork.releaseReserved(first.record);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.get(taskId, first.record.childWorkId))?.state, "released");
      yield* Effect.scoped(childWork.claimLaunch(second.record, { threadId: childThread }));
      yield* childWork.releaseReserved(second.record);
      assert.strictEqual((yield* store.get(taskId, second.record.childWorkId))?.state, "launched");
      // The first slot came back and the second stays held: exactly one more admission fits.
      const third = yield* admit("three");
      assert.strictEqual(third._tag, "admitted");
      const fourth = yield* Effect.flip(admit("four"));
      assert.strictEqual(fourth.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses new child work once the owning task is terminal", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
      const error = yield* Effect.flip(admit("too late"));
      assert.strictEqual(error.reason, "owner_terminal");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.deepStrictEqual(yield* store.listForTask(taskId), []);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("ChannelChildWork reconcile", () => {
  it.effect("releases a reservation whose owning task went terminal", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("reserved");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const record = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(record?.state, "released");
      // A terminal owner admits nothing new; the release keeps the accounting honest.
      const next = yield* Effect.flip(admit("after release"));
      assert.strictEqual(next.reason, "owner_terminal");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("settles a bound local record from its child run", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("local work");
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      yield* childWork.markBound(admission.record, { threadId: childThread });
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const record = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(record?.state, "completed");
    }).pipe(Effect.provide(makeLayer(new Map([[childThread, [fakeRun("completed")]]])))),
  );

  it.effect("keeps capacity while a local child is still starting or running", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const first = yield* admit("local one");
      const second = yield* admit("local two");
      if (first._tag === "not_channel_owned" || second._tag === "not_channel_owned")
        return yield* Effect.die("expected ownership");
      for (let i = 3; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE; i += 1) {
        yield* admit("local " + i);
      }
      yield* childWork.markBound(first.record, { threadId: childThread });
      yield* childWork.markBound(second.record, { threadId: ThreadId.make("child-2") });
      // child-2 has no runs at all: still starting, so the slot stays held.
      assert.strictEqual(yield* childWork.reconcile, 0);
      const third = yield* Effect.flip(admit("local three"));
      assert.strictEqual(third.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer(new Map([[childThread, [fakeRun("running")]]])))),
  );

  it.effect("binds a live remote dispatch and keeps a lost one's capacity as unknown", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* admit("remote work", { surface: "delegate_remote" });
      if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
      const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { correlationId, host: "box" }));
      const insertRow = (state: string) =>
        sql`INSERT INTO remote_dispatches
          (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, created_at, updated_at)
          VALUES (${correlationId}, 'thread', ${admission.record.callerThreadId}, 'box', 'read-key', 'wake', ${state}, ${NOW}, ${NOW})`;
      yield* insertRow("running");
      assert.strictEqual(yield* childWork.reconcile, 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual((yield* store.get(taskId, admission.record.childWorkId))?.state, "bound");
      yield* sql`UPDATE remote_dispatches SET state = 'lost' WHERE correlation_id = ${correlationId}`;
      assert.strictEqual(yield* childWork.reconcile, 1);
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "unknown",
      );
      // Unknown keeps the slot: only PR-D's resolve-or-fence may release it.
      for (let i = 2; i <= ChannelChildWork.CHANNEL_CHILD_WORK_MAX_ACTIVE; i += 1) {
        yield* admit("remote " + i, { surface: "delegate_remote" });
      }
      const refused = yield* Effect.flip(admit("third remote", { surface: "delegate_remote" }));
      assert.strictEqual(refused.reason, "at_capacity");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "keeps a launched remote record without a dispatch row while its launch is in flight, even once the task settles",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const admission = yield* admit("remote in flight", { surface: "delegate_remote" });
        if (admission._tag === "not_channel_owned") return yield* Effect.die("expected ownership");
        const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
        // The claim precedes the dispatch-row insert inside the launch call, so a reconcile
        // pass racing that window must hold the record and its capacity.
        yield* Effect.scoped(
          Effect.gen(function* () {
            assert.isTrue(
              yield* childWork.claimLaunch(admission.record, { correlationId, host: "box" }),
            );
            const second = yield* admit("second remote", { surface: "delegate_remote" });
            if (second._tag !== "admitted") return yield* Effect.die("expected admission");
            yield* move(taskId, { type: "task.cancelled", payload: { reason: "Stop" } });
            // Only the untouched reservation releases; the launch can still insert its row.
            assert.strictEqual(yield* childWork.reconcile, 1);
            const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
            const stateOf = (id: typeof second.record.childWorkId) =>
              store.get(taskId, id).pipe(Effect.map((record) => record?.state));
            assert.strictEqual(yield* stateOf(admission.record.childWorkId), "launched");
            assert.strictEqual(yield* stateOf(second.record.childWorkId), "released");
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "releases a launched remote record whose launch ended without a dispatch row, and keeps one whose row is still launching",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const sql = yield* SqlClient.SqlClient;
        const lost = yield* admit("remote lost pre-row", { surface: "delegate_remote" });
        const sent = yield* admit("remote sent", { surface: "delegate_remote" });
        if (lost._tag !== "admitted" || sent._tag !== "admitted")
          return yield* Effect.die("expected admission");
        const sentId = childWorkCorrelationIdFor(sent.record.childWorkId);
        for (const [record, correlationId] of [
          [lost.record, childWorkCorrelationIdFor(lost.record.childWorkId)],
          [sent.record, sentId],
        ] as const)
          yield* Effect.scoped(childWork.claimLaunch(record, { correlationId, host: "box" }));
        // The coordinator inserts the row before any remote write and restart recovery treats
        // a launching row as uncertain, so that one keeps its slot after the launch call ends.
        yield* sql`INSERT INTO remote_dispatches
          (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, created_at, updated_at)
          VALUES (${sentId}, 'thread', ${sent.record.callerThreadId}, 'box', 'read-key', 'wake', 'launching', ${NOW}, ${NOW})`;
        // The task is still live: a launch that ended without a row sent nothing either way.
        assert.strictEqual(yield* childWork.reconcile, 1);
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        assert.strictEqual((yield* store.get(taskId, lost.record.childWorkId))?.state, "released");
        assert.strictEqual((yield* store.get(taskId, sent.record.childWorkId))?.state, "launched");
        const next = yield* admit("after release", { surface: "delegate_remote" });
        assert.strictEqual(next._tag, "admitted");
      }).pipe(Effect.provide(makeLayer())),
  );
});

describe("ChannelChildWork cancelForTask", () => {
  it.effect("stops launched thread children and releases reservations on a task stop", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const launched = yield* admit("thread child", { surface: "thread_launch" });
      const reserved = yield* admit("reserved child", {
        surface: "thread_launch",
        destinationKey: "other-host",
      });
      if (launched._tag !== "admitted" || reserved._tag !== "admitted")
        return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(launched.record, { threadId: childThread }));
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId: taskEventIdFor(taskId, 99),
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      assert.deepStrictEqual(
        dispatched.map((entry) => ({
          threadId: entry.threadId,
          stopDelegatedTasks: entry.stopDelegatedTasks,
        })),
        [{ threadId: childThread, stopDelegatedTasks: true }],
      );
      assert.include(dispatched[0]!.commandId, "channel-stop-child");
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, launched.record.childWorkId))?.state,
        "cancelled",
      );
      assert.strictEqual(
        (yield* store.get(taskId, reserved.record.childWorkId))?.state,
        "released",
      );
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
  });

  it.effect("leaves delegated children to the worker's own cascade", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const delegate = yield* admit("delegate child");
      const thread = yield* admit("thread child", { surface: "thread_launch" });
      if (delegate._tag !== "admitted" || thread._tag !== "admitted")
        return yield* Effect.die("expected admission");
      yield* Effect.scoped(
        childWork.claimLaunch(delegate.record, {
          threadId: ThreadId.make("delegate-1"),
        }),
      );
      yield* Effect.scoped(childWork.claimLaunch(thread.record, { threadId: childThread }));
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId: taskEventIdFor(taskId, 99),
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      assert.deepStrictEqual(
        dispatched.map((entry) => entry.threadId),
        [childThread],
      );
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      // The delegate's stop arrives through the worker's subagent cascade; its record settles
      // when reconcile observes the run.
      assert.strictEqual(
        (yield* store.get(taskId, delegate.record.childWorkId))?.state,
        "launched",
      );
      assert.strictEqual((yield* store.get(taskId, thread.record.childWorkId))?.state, "cancelled");
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
  });

  it.effect("advances the owning stop's attempt when a child stop is refused while live", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      const stopEventId = taskEventIdFor(taskId, 99);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const first = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(first, "retry");
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 1);
      const second = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 1,
        reason: "Stopped.",
      });
      assert.strictEqual(second, "retry");
      // A refused command id is refused for good, so the retry used a fresh one.
      assert.notStrictEqual(dispatched[1]!.commandId, dispatched[0]!.commandId);
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 2);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("running")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
        ),
      ),
    );
  });

  it.effect("settles a refused child stop when the thread already ended", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "settled");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 0);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "cancelled",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("cancelled")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
        ),
      ),
    );
  });

  it.effect("keeps retrying a refused child stop while a cloud task keeps the thread live", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "retry");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 1);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("cancelled")]]]),
          new Map([[childThread, { _tag: "OrchestratorCommandRejectedError" }]]),
          dispatched,
          new Map([
            [
              childThread,
              [
                {
                  id: "pt-1",
                  providerInstanceId: "pi-1",
                  cloudTask: { status: "running" },
                  pendingBackgroundTasks: [],
                },
              ],
            ],
          ]),
        ),
      ),
    );
  });

  it.effect("keeps the stop pending when a child stop dispatch fails transiently", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const admission = yield* admit("thread child", { surface: "thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { threadId: childThread }));
      const stopEventId = taskEventIdFor(taskId, 99);
      const outcome = yield* childWork.cancelForTask({
        taskId,
        generation: 1,
        stopEventId,
        attempt: 0,
        reason: "Stopped.",
      });
      assert.strictEqual(outcome, "retry");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.strictEqual(yield* ledger.stopAttempt(stopEventId), 0);
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      assert.strictEqual(
        (yield* store.get(taskId, admission.record.childWorkId))?.state,
        "launched",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          new Map([[childThread, [fakeRun("running")]]]),
          new Map([[childThread, new Error("connection reset")]]),
          dispatched,
        ),
      ),
    );
  });
});

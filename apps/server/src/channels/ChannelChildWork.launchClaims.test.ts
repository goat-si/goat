import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelChildWork as ChannelChildWorkRecord,
  type ChannelTask,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { taskEventIdFor } from "./channelIds.ts";
import {
  admit,
  childThread,
  type DispatchedStop,
  isChildWorkError,
  makeLayer,
  missingThread,
  type RecordReads,
  seedWorker,
} from "./testkit/channelChildWorkFixture.ts";

describe("ChannelChildWork launch claims (#1387)", () => {
  const stop = (taskId: ChannelTask["taskId"]) =>
    ChannelChildWork.ChannelChildWork.pipe(
      Effect.flatMap((childWork) =>
        childWork.cancelForTask({
          taskId,
          generation: 1,
          stopEventId: taskEventIdFor(taskId, 99),
          attempt: 0,
          reason: "Stopped.",
        }),
      ),
    );
  const stateOf = (
    taskId: ChannelTask["taskId"],
    admission: { readonly record: ChannelChildWorkRecord },
  ) =>
    ChannelChildWorkStore.ChannelChildWorkStore.pipe(
      Effect.flatMap((store) => store.get(taskId, admission.record.childWorkId)),
      Effect.map((record) => record?.state),
    );
  const threadChild = (prompt: string) =>
    admit(prompt, { surface: "thread_launch", destinationKey: prompt }).pipe(
      Effect.flatMap((admission) =>
        admission._tag === "admitted"
          ? Effect.succeed(admission)
          : Effect.die("expected admission"),
      ),
    );

  it.effect(
    "regression #1387: a stop before the claim releases the slot and refuses the launch",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const child = yield* threadChild("not yet claimed");
        assert.strictEqual(yield* stop(taskId), "settled");
        const claimed = yield* Effect.scoped(
          childWork.claimLaunch(child.record, { threadId: childThread }),
        );
        assert.isFalse(claimed);
        assert.strictEqual(yield* stateOf(taskId, child), "released");
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "regression #1387: a stop waits for a launch in flight and still stops the other children",
    () => {
      const dispatched: Array<DispatchedStop> = [];
      const otherThread = ThreadId.make("child-2");
      return Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const launching = yield* threadChild("launching");
        const running = yield* threadChild("running");
        yield* Effect.scoped(childWork.claimLaunch(running.record, { threadId: otherThread }));
        yield* childWork.markBound(running.record);
        yield* Effect.scoped(
          Effect.gen(function* () {
            assert.isTrue(
              yield* childWork.claimLaunch(launching.record, { threadId: childThread }),
            );
            // Its thread does not exist yet, so a stop now would wrongly settle it as missing.
            assert.strictEqual(yield* stop(taskId), "retry");
            assert.deepStrictEqual(
              dispatched.map((entry) => entry.threadId),
              [otherThread],
            );
            assert.strictEqual(yield* stateOf(taskId, launching), "launched");
            assert.strictEqual(yield* stateOf(taskId, running), "cancelled");
            // Its slot still counts.
            yield* threadChild("third");
            const refused = yield* Effect.flip(threadChild("fourth"));
            assert.strictEqual(isChildWorkError(refused) && refused.reason, "at_capacity");
            yield* childWork.markBound(launching.record);
          }),
        );
        assert.strictEqual(yield* stop(taskId), "settled");
        assert.deepStrictEqual(
          dispatched.map((entry) => entry.threadId),
          [otherThread, childThread],
        );
        assert.strictEqual(yield* stateOf(taskId, launching), "cancelled");
      }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
    },
  );

  it.effect("a stop releases a launch that ended without creating its thread", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const child = yield* threadChild("never created");
      yield* Effect.scoped(childWork.claimLaunch(child.record, { threadId: childThread }));
      assert.strictEqual(yield* stop(taskId), "settled");
      assert.strictEqual(yield* stateOf(taskId, child), "released");
    }).pipe(Effect.provide(makeLayer(new Map(), new Map([[childThread, missingThread]])))),
  );

  it.effect("a failed stop keeps that child's record and slot while the others still stop", () => {
    const otherThread = ThreadId.make("child-2");
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const failing = yield* threadChild("failing stop");
      const stopping = yield* threadChild("stopping");
      for (const [child, threadId] of [
        [failing, childThread],
        [stopping, otherThread],
      ] as const) {
        yield* Effect.scoped(childWork.claimLaunch(child.record, { threadId }));
        yield* childWork.markBound(child.record);
      }
      assert.strictEqual(yield* stop(taskId), "retry");
      assert.strictEqual(yield* stateOf(taskId, failing), "bound");
      assert.strictEqual(yield* stateOf(taskId, stopping), "cancelled");
      yield* threadChild("third");
      const refused = yield* Effect.flip(threadChild("fourth"));
      assert.strictEqual(isChildWorkError(refused) && refused.reason, "at_capacity");
    }).pipe(
      Effect.provide(makeLayer(new Map(), new Map([[childThread, new Error("connection reset")]]))),
    );
  });

  it.effect("a duplicate claim loses without ending the winner's launch", () => {
    const dispatched: Array<DispatchedStop> = [];
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const child = yield* threadChild("claimed twice");
      yield* Effect.scoped(
        Effect.gen(function* () {
          assert.isTrue(yield* childWork.claimLaunch(child.record, { threadId: childThread }));
          const duplicate = childWork.claimLaunch(child.record, { threadId: childThread });
          assert.isFalse(yield* Effect.scoped(duplicate));
          assert.strictEqual(yield* stop(taskId), "retry");
          assert.deepStrictEqual(dispatched, []);
        }),
      );
      assert.strictEqual(yield* stop(taskId), "settled");
      assert.strictEqual(yield* stateOf(taskId, child), "cancelled");
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), dispatched)));
  });

  it.effect(
    "reconcile releases a launch that ended without its thread, as after a restart, and keeps one in flight or unreadable",
    () => {
      const reads: RecordReads = { failures: new Map([[childThread, missingThread]]) };
      const otherThread = ThreadId.make("child-2");
      reads.failures.set(otherThread, missingThread);
      return Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const inFlight = yield* threadChild("in flight");
        const ended = yield* threadChild("ended");
        yield* Effect.scoped(childWork.claimLaunch(ended.record, { threadId: otherThread }));
        yield* Effect.scoped(
          Effect.gen(function* () {
            assert.isTrue(yield* childWork.claimLaunch(inFlight.record, { threadId: childThread }));
            assert.strictEqual(yield* childWork.reconcile, 1);
            assert.strictEqual(yield* stateOf(taskId, inFlight), "launched");
            assert.strictEqual(yield* stateOf(taskId, ended), "released");
          }),
        );
        reads.failures.set(childThread, new Error("database is locked"));
        assert.strictEqual(yield* childWork.reconcile, 0);
        reads.failures.set(childThread, missingThread);
        assert.strictEqual(yield* childWork.reconcile, 1);
        assert.strictEqual(yield* stateOf(taskId, inFlight), "released");
      }).pipe(Effect.provide(makeLayer(new Map(), new Map(), [], new Map(), reads)));
    },
  );

  it.effect("reconcile keeps a launch that ends while its thread is being read", () => {
    const reads: RecordReads = { failures: new Map([[childThread, missingThread]]) };
    return Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const child = yield* threadChild("stale read");
      const launch = yield* Scope.make();
      assert.isTrue(
        yield* childWork
          .claimLaunch(child.record, { threadId: childThread })
          .pipe(Effect.provideService(Scope.Scope, launch)),
      );
      // The read saw no thread, but the launch created it and ended before the read returned.
      reads.during = () => Scope.close(launch, Exit.void);
      assert.strictEqual(yield* childWork.reconcile, 0);
      assert.strictEqual(yield* stateOf(taskId, child), "launched");
    }).pipe(Effect.provide(makeLayer(new Map(), new Map(), [], new Map(), reads)));
  });
});

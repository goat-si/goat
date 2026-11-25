import {
  type ChannelDeliverable,
  type ChannelTaskId,
  requiredDeliverableRequestKey,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { retryRequiredDeliverable } from "./channelDeliverableRetry.ts";
import {
  admit,
  childThread,
  isChildWorkError,
  makeLayer,
  move,
  seedWorker,
} from "./testkit/channelChildWorkFixture.ts";

const key = requiredDeliverableRequestKey;
const mac: ChannelDeliverable = { id: "mac", criterion: "Build and launch", attempt: 1 };
const linux: ChannelDeliverable = { id: "linux", criterion: "Run Linux tests", attempt: 1 };
const delegate = (attempt: number, changes?: { destinationKey?: string; prompt?: string }) =>
  admit(changes?.prompt ?? "Run the regression suite.", {
    surface: "delegate_remote",
    clientRequestId: key(linux.id, attempt),
    destinationKey: changes?.destinationKey ?? "linux:/repo",
  });

const seedPlan = (taskId: ChannelTaskId, items: ReadonlyArray<ChannelDeliverable>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_tasks SET task_json =
      json_set(task_json, '$.requiredDeliverables', json(${JSON.stringify(items)}))
      WHERE task_id = ${taskId}`;
  });

describe("retrying a required worker", () => {
  it.effect("refuses a required attempt that the parent never declared", () =>
    Effect.gen(function* () {
      yield* seedWorker;
      const failure = yield* delegate(1).pipe(Effect.flip);
      assert.isTrue(isChildWorkError(failure));
      assert.strictEqual(failure.reason, "invalid_deliverable");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "retries Linux with its original instruction and machine while retaining the accepted Mac result",
    () =>
      Effect.gen(function* () {
        const task = yield* seedWorker;
        yield* seedPlan(task, [mac, linux]);
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;

        const build = yield* admit("Build and launch.", { clientRequestId: key(mac.id, 1) });
        const first = yield* delegate(1);
        assert.strictEqual(build._tag, "admitted");
        assert.strictEqual(first._tag, "admitted");
        if (build._tag !== "admitted" || first._tag !== "admitted") return;
        assert.strictEqual(first.requestKey, first.record.childWorkId);
        yield* Effect.scoped(childWork.claimLaunch(build.record, { threadId: childThread }));
        yield* childWork.markTerminal(build.record, "completed");
        const accepted = {
          ...mac,
          review: {
            decision: "accepted" as const,
            childWorkId: build.record.childWorkId,
            evidence: "Mac app launched.",
          },
        };
        const plan = [accepted, linux];
        yield* seedPlan(task, plan);
        const retry = { id: "linux", attempt: 1 };
        assert.isUndefined(
          retryRequiredDeliverable(
            plan,
            { id: "mac", attempt: 1 },
            yield* store.get(task, build.record.childWorkId),
          ),
        );
        assert.isUndefined(retryRequiredDeliverable(plan, retry, first.record));
        assert.strictEqual((yield* delegate(2).pipe(Effect.flip)).reason, "invalid_deliverable");

        yield* Effect.scoped(
          childWork.claimLaunch(first.record, { host: "linux", correlationId: "linux-first" }),
        );
        yield* childWork.markTerminal(first.record, "failed");
        const old = yield* store.get(task, first.record.childWorkId);
        const next = retryRequiredDeliverable(plan, retry, old);
        assert.deepStrictEqual(next, [accepted, { ...linux, attempt: 2 }]);
        if (!next) return;
        yield* seedPlan(task, next);
        assert.isUndefined(retryRequiredDeliverable(next, retry, old));
        assert.strictEqual((yield* delegate(1).pipe(Effect.flip)).reason, "invalid_deliverable");
        assert.strictEqual(
          (yield* delegate(2, { destinationKey: "mac:/repo" }).pipe(Effect.flip)).reason,
          "invalid_deliverable",
        );
        assert.strictEqual(
          (yield* delegate(2, { prompt: "Do something else." }).pipe(Effect.flip)).reason,
          "invalid_deliverable",
        );

        const second = yield* delegate(2);
        const duplicate = yield* delegate(2);
        assert.strictEqual(second._tag, "admitted");
        assert.strictEqual(duplicate._tag, "existing");
        if (second._tag !== "admitted" || duplicate._tag !== "existing") return;
        assert.notStrictEqual(second.record.childWorkId, first.record.childWorkId);
        assert.strictEqual(duplicate.record.childWorkId, second.record.childWorkId);
        yield* childWork.markTerminal(first.record, "completed");
        assert.strictEqual((yield* store.get(task, first.record.childWorkId))?.state, "failed");
        assert.strictEqual((yield* store.get(task, second.record.childWorkId))?.state, "reserved");
        assert.strictEqual((yield* store.get(task, build.record.childWorkId))?.state, "completed");
        assert.lengthOf(yield* store.listForTask(task), 3);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "allows a finished worker with a missing report to retry only on failure evidence from that attempt",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        yield* seedPlan(taskId, [mac, linux]);
        const first = yield* delegate(1);
        const other = yield* admit("Build.", { clientRequestId: key(mac.id, 1) });
        if (first._tag !== "admitted" || other._tag !== "admitted")
          return yield* Effect.die("expected both delegates");
        const children = yield* ChannelChildWork.ChannelChildWork;
        yield* Effect.scoped(
          children.claimLaunch(first.record, { host: "linux", correlationId: "linux" }),
        );
        yield* children.markTerminal(first.record, "completed");
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const old = yield* store.get(taskId, first.record.childWorkId);
        const request = { id: "linux", attempt: 1 };
        for (const observed of [
          { state: "awaiting_acceptance", childWorkId: first.record.childWorkId },
          { state: "failed", childWorkId: other.record.childWorkId },
        ] as const)
          assert.isUndefined(retryRequiredDeliverable([linux], request, old, observed));
        assert.deepStrictEqual(
          retryRequiredDeliverable([linux], request, old, {
            state: "failed",
            childWorkId: first.record.childWorkId,
          }),
          [{ ...linux, attempt: 2 }],
        );
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("ends a retry when the parent fails before the next child is admitted", () =>
    Effect.gen(function* () {
      const task = yield* seedWorker;
      yield* seedPlan(task, [linux]);
      const first = yield* delegate(1);
      if (first._tag !== "admitted") return yield* Effect.die("expected first attempt");
      const children = yield* ChannelChildWork.ChannelChildWork;
      yield* children.markTerminal(first.record, "failed");
      yield* seedPlan(task, [{ ...linux, attempt: 2 }]);
      yield* move(task, {
        type: "task.failed",
        payload: { generation: 1, reason: "worker_failed", summary: "Linux tests failed." },
      });
      const failure = yield* delegate(2).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "owner_terminal");
    }).pipe(Effect.provide(makeLayer())),
  );
});

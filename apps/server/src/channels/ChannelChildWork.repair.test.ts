import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ChannelChildWork from "./ChannelChildWork.ts";
import * as ChannelChildWorkStore from "./channelChildWorkStore.ts";
import { childWorkCorrelationIdFor } from "./channelIds.ts";
import { admit, makeLayer, NOW, seedWorker } from "./testkit/channelChildWorkFixture.ts";

/** A remote launch that settled on an older build before its acknowledged thread was recorded. */
const SETTLED_AT = "2026-10-01T00:00:00.000Z";
const settledWithoutThread = Effect.fn("test.settledWithoutThread")(function* (
  key: string,
  state: "completed" | "failed" | "cancelled",
  remoteThreadId: string | null,
  dispatch: { readonly kind: string; readonly host: string } = { kind: "thread", host: "box" },
) {
  const childWork = yield* ChannelChildWork.ChannelChildWork;
  const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
  const sql = yield* SqlClient.SqlClient;
  const admission = yield* admit("remote thread " + key, { surface: "ssh_thread_launch" });
  if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
  const { record } = admission;
  const correlationId = childWorkCorrelationIdFor(record.childWorkId);
  yield* Effect.scoped(childWork.claimLaunch(record, { correlationId, host: "box" }));
  yield* store.transition({
    taskId: record.taskId,
    childWorkId: record.childWorkId,
    from: ["launched"],
    to: state,
    now: SETTLED_AT,
  });
  yield* sql`INSERT INTO remote_dispatches
    (correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state, created_at, updated_at)
    VALUES (${correlationId}, ${dispatch.kind}, ${record.callerThreadId}, ${dispatch.host}, ${remoteThreadId}, 'read-key', 'wake', 'settled', ${NOW}, ${NOW})`;
  return record;
});

describe("ChannelChildWork repair of settled remote launches", () => {
  it.effect.each(["completed", "failed", "cancelled"] as const)(
    "regression: a %s remote launch gets back the thread its host acknowledged, state unchanged",
    (state) =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const record = yield* settledWithoutThread("one", state, "remote-thread");
        assert.strictEqual(yield* childWork.reconcile, 1);
        const repaired = yield* store.get(taskId, record.childWorkId);
        assert.strictEqual(repaired?.state, state);
        assert.strictEqual(repaired?.destination?.threadId, "remote-thread");
        assert.strictEqual(
          repaired?.destination?.correlationId,
          childWorkCorrelationIdFor(record.childWorkId),
        );
        assert.strictEqual(repaired?.updatedAt, SETTLED_AT);
        assert.strictEqual(yield* childWork.reconcile, 0);
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect.each([
    ["another kind", { kind: "task", host: "box" }],
    ["another host", { kind: "thread", host: "elsewhere" }],
  ] as const)("invariant: a dispatch row of %s never fills a settled launch", ([, dispatch]) =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const record = yield* settledWithoutThread("one", "completed", "remote-thread", dispatch);
      assert.strictEqual(yield* childWork.reconcile, 0);
      assert.isUndefined((yield* store.get(taskId, record.childWorkId))?.destination?.threadId);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("invariant: never replaces a thread a settled launch already has", () =>
    Effect.gen(function* () {
      const taskId = yield* seedWorker;
      const childWork = yield* ChannelChildWork.ChannelChildWork;
      const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
      const sql = yield* SqlClient.SqlClient;
      const admission = yield* admit("remote thread", { surface: "ssh_thread_launch" });
      if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
      const correlationId = childWorkCorrelationIdFor(admission.record.childWorkId);
      yield* Effect.scoped(childWork.claimLaunch(admission.record, { correlationId, host: "box" }));
      yield* childWork.markBound(admission.record, {
        correlationId,
        host: "box",
        threadId: ThreadId.make("own-thread"),
      });
      yield* childWork.markTerminal(admission.record, "completed");
      yield* sql`INSERT INTO remote_dispatches
        (correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery, state, created_at, updated_at)
        VALUES (${correlationId}, 'thread', ${admission.record.callerThreadId}, 'box', 'other-thread', 'read-key', 'wake', 'settled', ${NOW}, ${NOW})`;
      assert.strictEqual(yield* childWork.reconcile, 0);
      const kept = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(kept?.destination?.threadId, "own-thread");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "contract: a pass inspects one page of child work, so a launch behind a page of unrepairable ones is filled, and a walk that fills nothing ends the repair",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const sql = yield* SqlClient.SqlClient;
        const page = ChannelChildWork.REMOTE_THREAD_REPAIR_PAGE;
        // Acknowledged ids no ThreadId accepts: they match the dispatch but can never be filled.
        const records = [];
        for (let index = 0; index <= page; index += 1) {
          records.push(yield* settledWithoutThread(String(index), "completed", "\u00a0"));
        }
        // Byte order, as SQLite orders the keys.
        const last = records.toSorted((a, b) => (a.childWorkId < b.childWorkId ? -1 : 1)).at(-1);
        if (last === undefined) return yield* Effect.die("expected records");
        yield* sql`UPDATE remote_dispatches SET remote_thread_id = 'remote-thread'
        WHERE correlation_id = ${childWorkCorrelationIdFor(last.childWorkId)}`;
        const counted = store as {
          pageSettledLaunches: typeof store.pageSettledLaunches;
        };
        const read = counted.pageSettledLaunches;
        let pageReads = 0;
        counted.pageSettledLaunches = (after, limit) => {
          pageReads += 1;
          return read(after, limit);
        };
        const passes = [];
        for (let pass = 0; pass < 6; pass += 1) passes.push(yield* childWork.reconcile);
        // Two pages fill the last row; a second walk fills nothing, and then no page is read again.
        assert.deepStrictEqual(passes, [0, 1, 0, 0, 0, 0]);
        assert.strictEqual(pageReads, 4);
        const filled = yield* store.get(taskId, last.childWorkId);
        assert.strictEqual(filled?.destination?.threadId, "remote-thread");
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "regression: a stopped repair walk walks again after ten minutes and fills a thread its dispatch gained since",
    () =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const sql = yield* SqlClient.SqlClient;
        const record = yield* settledWithoutThread("late", "completed", null);
        const counted = store as { pageSettledLaunches: typeof store.pageSettledLaunches };
        const read = counted.pageSettledLaunches;
        let pageReads = 0;
        counted.pageSettledLaunches = (after, limit) => {
          pageReads += 1;
          return read(after, limit);
        };
        // A whole walk filled nothing, so the repair stops and reads no page.
        assert.deepStrictEqual([yield* childWork.reconcile, yield* childWork.reconcile], [0, 0]);
        assert.strictEqual(pageReads, 1);
        // A lost launch is recovered later and its dispatch gains the thread.
        yield* sql`UPDATE remote_dispatches SET remote_thread_id = 'remote-thread'
        WHERE correlation_id = ${childWorkCorrelationIdFor(record.childWorkId)}`;
        yield* TestClock.adjust(Duration.minutes(9));
        assert.strictEqual(yield* childWork.reconcile, 0);
        assert.strictEqual(pageReads, 1);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.strictEqual(yield* childWork.reconcile, 1);
        const filled = yield* store.get(taskId, record.childWorkId);
        assert.strictEqual(filled?.destination?.threadId, "remote-thread");
        // That walk filled one, so one more walk runs, finds nothing and stops again.
        assert.strictEqual(yield* childWork.reconcile, 0);
        const reads = pageReads;
        assert.strictEqual(yield* childWork.reconcile, 0);
        assert.strictEqual(pageReads, reads);
      }).pipe(Effect.provide(makeLayer())),
  );
});

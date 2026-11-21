import { assert, describe, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Coordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import {
  makeFixture,
  remote,
  remoteEnvironment,
} from "../remoteReports/RemoteDispatchCoordinator.testkit.ts";
import { bindRemoteChildWork } from "../mcp/childWorkAdmission.ts";
import * as Option from "effect/Option";

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
  it.effect.each([
    { kind: "thread", state: "running", bindFirst: false },
    { kind: "thread", state: "settled", bindFirst: false },
    { kind: "task", state: "running", bindFirst: false },
    { kind: "task", state: "settled", bindFirst: false },
    { kind: "task", state: "running", bindFirst: true },
    { kind: "task", state: "settled", bindFirst: true },
  ] as const)(
    "keeps the verified destination for a $state $kind dispatch (caller binds first: $bindFirst)",
    ({ kind, state, bindFirst }) =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* makeFixture(false);
        const admission = yield* admit("remote " + kind, {
          surface: kind === "thread" ? "ssh_thread_launch" : "delegate_remote",
        });
        if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
        const record = admission.record;
        const correlationId = childWorkCorrelationIdFor(record.childWorkId);
        yield* Effect.scoped(
          Effect.gen(function* () {
            assert.isTrue(yield* childWork.claimLaunch(record, { correlationId, host: "box" }));
            const result = yield* Coordinator.RemoteDispatchCoordinator.use((coordinator) =>
              coordinator.launch(
                {
                  ...(kind === "thread"
                    ? { kind }
                    : {
                        kind,
                        task: {
                          taskId: NodeId.make("delegate"),
                          parentRunId: RunId.make("parent"),
                        },
                      }),
                  originThreadId: record.callerThreadId,
                  delivery: "wake",
                  correlationId,
                  launch: {
                    host: "box",
                    cwd: "/fixture",
                    workspace: { type: "cwd" },
                    title: "fixture",
                    runtimeMode: "full-access",
                    callerRuntimeMode: "full-access",
                  },
                },
                Effect.void,
              ),
            ).pipe(Effect.provide(fixture.layer));
            if (bindFirst) {
              yield* bindRemoteChildWork(Option.some(childWork), admission, "box", result);
            }
            if (state === "settled") {
              yield* sql`UPDATE remote_dispatches SET state = 'settled' WHERE correlation_id = ${correlationId}`;
            }
            yield* childWork.reconcile;
            const reconciled = yield* store.get(taskId, record.childWorkId);
            if (!bindFirst) {
              yield* bindRemoteChildWork(Option.some(childWork), admission, "box", result);
            }
            const saved = yield* store.get(taskId, record.childWorkId);
            assert.strictEqual(saved?.state, state === "running" ? "bound" : "completed");
            assert.deepStrictEqual(saved, reconciled);
            assert.deepStrictEqual(saved?.destination, {
              host: "box",
              correlationId,
              threadId: remote,
              environmentId: remoteEnvironment,
            });
          }),
        );
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect.each(["matching", "wrong-host", "wrong-correlation", "wrong-kind"] as const)(
    "repairs an already settled remote delegate only from its own dispatch (%s)",
    (match) =>
      Effect.gen(function* () {
        const taskId = yield* seedWorker;
        const childWork = yield* ChannelChildWork.ChannelChildWork;
        const store = yield* ChannelChildWorkStore.ChannelChildWorkStore;
        const sql = yield* SqlClient.SqlClient;
        const admission = yield* admit("delegate " + match, { surface: "delegate_remote" });
        if (admission._tag !== "admitted") return yield* Effect.die("expected admission");
        const { record } = admission;
        const correlationId = childWorkCorrelationIdFor(record.childWorkId);
        yield* Effect.scoped(childWork.claimLaunch(record, { correlationId, host: "box" }));
        yield* store.transition({
          taskId,
          childWorkId: record.childWorkId,
          from: ["launched"],
          to: "completed",
          destination: { correlationId, host: "box", threadId: remote },
          now: SETTLED_AT,
        });
        yield* sql`INSERT INTO remote_dispatches
          (correlation_id, kind, origin_thread_id, host, remote_thread_id, remote_environment_id, read_key, delivery, state, created_at, updated_at)
          VALUES (${match === "wrong-correlation" ? "other-dispatch" : correlationId},
            ${match === "wrong-kind" ? "thread" : "task"}, ${record.callerThreadId},
            ${match === "wrong-host" ? "elsewhere" : "box"}, ${remote}, ${remoteEnvironment},
            'read-key', 'wake', 'settled', ${NOW}, ${NOW})`;
        assert.strictEqual(yield* childWork.reconcile, match === "matching" ? 1 : 0);
        const saved = yield* store.get(taskId, record.childWorkId);
        assert.strictEqual(saved?.state, "completed");
        assert.strictEqual(saved?.updatedAt, SETTLED_AT);
        assert.strictEqual(
          saved?.destination?.environmentId,
          match === "matching" ? remoteEnvironment : undefined,
        );
      }).pipe(Effect.provide(makeLayer())),
  );

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
        (correlation_id, kind, origin_thread_id, host, remote_thread_id, remote_environment_id, read_key, delivery, state, created_at, updated_at)
        VALUES (${correlationId}, 'thread', ${admission.record.callerThreadId}, 'box', 'other-thread', ${remoteEnvironment}, 'read-key', 'wake', 'settled', ${NOW}, ${NOW})`;
      assert.strictEqual(yield* childWork.reconcile, 0);
      const kept = yield* store.get(taskId, admission.record.childWorkId);
      assert.strictEqual(kept?.destination?.threadId, "own-thread");
      assert.isUndefined(kept?.destination?.environmentId);
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

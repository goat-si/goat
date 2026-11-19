import { assert, it } from "@effect/vitest";
import { EventId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

export function settlementCadenceTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
}: Pick<typeof Harness, "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness">) {
  it.effect("rereads a branch without a pull request less often the longer its thread idles", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const recent = makeThread("recent-branch", {
        branch: "recent-feature",
        latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 30 * 60 * 1_000),
      });
      const old = makeThread("old-branch", {
        branch: "old-feature",
        latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
      });
      const fixture = yield* makeHarness({ snapshot: makeSnapshot([recent, old]) });
      const branches = Ref.get(fixture.branchCalls).pipe(
        Effect.map((calls) => calls.map((call) => call.branch).sort()),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        for (let minute = 1; minute <= 29; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
        }
        assert.deepStrictEqual(yield* branches, ["old-feature", "recent-feature"]);

        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* branches, [
          "old-feature",
          "recent-feature",
          "recent-feature",
        ]);

        // Work ending in the thread reads its branch at once.
        yield* fixture.publishEvent({
          type: "run.background-work-cancelled",
          id: EventId.make("event:old-branch:run-ended"),
          threadId: old.id,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: { runId: RunId.make("run:old-branch"), restartCancelledBackgroundWork: [] },
        });
        yield* Queue.take(fixture.snapshotReads);
        yield* reactor.drain;
        assert.deepStrictEqual(yield* branches, [
          "old-feature",
          "old-feature",
          "recent-feature",
          "recent-feature",
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a sweep looks up a few branches without a pull request, not every one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const threads = Array.from({ length: 10 }, (_, index) =>
        makeThread(`idle-${index}`, {
          branch: `idle-${index}`,
          latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - (index + 10) * 60 * 1_000),
        }),
      );
      const fixture = yield* makeHarness({ snapshot: makeSnapshot(threads) });
      const branches = Ref.get(fixture.branchCalls).pipe(
        Effect.map((calls) => calls.map((call) => call.branch).sort()),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
        // The most recently active first, then the rest in turn, each once.
        assert.deepStrictEqual(yield* branches, ["idle-0", "idle-1", "idle-2", "idle-3"]);
        for (let minute = 1; minute <= 5; minute += 1) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;
        }
        assert.deepStrictEqual(
          yield* branches,
          threads.map((thread) => thread.branch),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("scheduled and immediate reads share the eight lookup limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const entered = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const inFlight = yield* Ref.make(0);
        const peak = yield* Ref.make(0);
        const threads = Array.from({ length: 10 }, (_, index) =>
          makeThread(`concurrency-${index}`, { branch: `concurrency-${index}` }),
        );
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(threads),
          branchPullRequest: Effect.fn("cadenceTest.branchPullRequest")(function* () {
            const current = yield* Ref.updateAndGet(inFlight, (value) => value + 1);
            yield* Ref.update(peak, (value) => Math.max(value, current));
            yield* Queue.offer(entered, undefined);
            yield* Deferred.await(release);
            yield* Ref.update(inFlight, (value) => value - 1);
            return null;
          }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.snapshotReads);
          for (let i = 0; i < 4; i++) yield* Queue.take(entered);
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 20 });
          for (const thread of threads.slice(4, 10)) {
            yield* fixture.publishEvent({
              type: "run.background-work-cancelled",
              id: EventId.make(`concurrency:${thread.id}`),
              threadId: thread.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: {
                runId: RunId.make(`run:${thread.id}`),
                restartCancelledBackgroundWork: [],
              },
            });
          }
          for (let i = 0; i < 4; i++) yield* Queue.take(entered);
          assert.strictEqual(yield* Ref.get(peak), 8);
          yield* Deferred.succeed(release, undefined);
          yield* reactor.drain;
          assert.isAtMost(yield* Ref.get(peak), 8);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
}

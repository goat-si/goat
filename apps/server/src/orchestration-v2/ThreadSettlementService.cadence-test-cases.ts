import { assert, it } from "@effect/vitest";
import { EventId, RunId, SourceControlProviderKind } from "@goat/contracts";
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
  it.effect("quiet open pull requests are read every five minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("quiet-pr", {
        branch: "feature",
        branchPullRequest: {
          projectId: makeThread("project").projectId,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        },
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        pullRequestSummary: (input) =>
          Effect.succeed({
            ...input,
            provider: SourceControlProviderKind.make("github"),
            title: "Pull request",
            url: "https://example.test/owner/repository/pull/42",
            state: "open" as const,
            headBranch: "feature",
            baseBranch: "main",
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS)),
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        for (let minute = 1; minute <= 4; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
        }
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 1);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* service.drain;
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* service.drain;
        assert.strictEqual((yield* Ref.get(fixture.summaryCalls)).length, 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("a PR refresh immediately rereads a quiet open pull request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const readAgain = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const thread = makeThread("quiet-refresh", {
        branch: "feature",
        branchPullRequest: {
          projectId: makeThread("project").projectId,
          repository: "owner/repository",
          number: 42,
          url: "https://example.test/owner/repository/pull/42",
        },
      });
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        pullRequestSummary: Effect.fn("cadenceTest.refreshSummary")(function* (input) {
          const count = yield* Ref.updateAndGet(calls, (value) => value + 1);
          if (count === 2) yield* Deferred.succeed(readAgain, undefined);
          return {
            ...input,
            provider: SourceControlProviderKind.make("github"),
            title: "Pull request",
            url: "https://example.test/owner/repository/pull/42",
            state: "open" as const,
            headBranch: "feature",
            baseBranch: "main",
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS)),
          };
        }),
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        assert.strictEqual(yield* Ref.get(calls), 1);
        yield* fixture.publishRefresh;
        yield* Deferred.await(readAgain);
        yield* service.drain;
        assert.strictEqual(yield* Ref.get(calls), 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
}

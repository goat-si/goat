import { assert, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import type * as GitManager from "../git/GitManager.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

function makeBranchPullRequest(state: "open" | "closed" | "merged") {
  return {
    number: 42,
    title: "Pull request",
    url: "https://example.test/owner/repository/pull/42",
    baseRef: "main",
    headRef: "feature",
    state,
    repositoryKey: "example.test/owner/repository",
    updatedAt: NOW,
    closedAt: state === "closed" ? NOW : null,
    mergedAt: state === "merged" ? NOW : null,
  } satisfies GitManager.GitBranchPullRequest;
}

// GitManager rereads git state on request, and by default whenever its
// remembered answer is merged or closed.
function readsFreshGitState(
  options: Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1],
): boolean {
  return (
    options?.refresh === true ||
    options?.freshGitState === true ||
    options?.confirmTerminal !== false
  );
}

// Keep the regression cases separate because the existing suite is at its file budget.
export function settlementSweepCacheTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
}: Pick<typeof Harness, "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness">) {
  it.effect("reuses unchanged branch lookups across sweeps and unrelated thread updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("unchanged", { branch: "feature" });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* TestClock.adjust("1 minute");
          yield* service.drain;
          expect((yield* Ref.get(fixture.branchCalls)).length).toBe(1);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([{ ...thread, updatedAt: DateTime.makeUnsafe(NOW) }]),
          );
          yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 20 });
          yield* Queue.take(fixture.snapshotReads);
          yield* Queue.take(fixture.snapshotReads);
          yield* service.drain;
          expect((yield* Ref.get(fixture.branchCalls)).length).toBe(1);
          yield* TestClock.adjust("24 hours");
          yield* service.drain;
          expect((yield* Ref.get(fixture.branchCalls)).length).toBe(2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("starts the PR refresh window after a slow lookup completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("slow", { branch: "feature" })]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(null),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Deferred.await(started);
          yield* TestClock.adjust("1 minute");
          yield* Deferred.succeed(release, undefined);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* service.drain;
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
          yield* TestClock.adjust("24 hours");
          yield* service.drain;
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retries failed branch lookups on the next sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const attempts = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("retry", { branch: "feature" })]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: () =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.die("lookup unavailable") : Effect.succeed(null),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* TestClock.adjust("1 minute");
          yield* service.drain;
          expect(yield* Ref.get(attempts)).toBe(2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "keeps an overdue unlinked branch thread with an open PR when retention is enabled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const thread = makeThread("overdue-open-pr", { branch: "feature" });
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([thread]),
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: 2,
              sidebarAutoSettleKeepPullRequests: true,
            },
            branchPullRequest: () =>
              Effect.succeed({
                number: 42,
                title: "Pull request",
                url: "https://example.test/owner/repository/pull/42",
                baseRef: "main",
                headRef: "feature",
                state: "open" as const,
                repositoryKey: "example.test/owner/repository",
                updatedAt: NOW,
                closedAt: null,
                mergedAt: null,
              }),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("keeps an overdue unlinked branch thread when its PR lookup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("overdue-lookup-failure", { branch: "feature" });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          branchPullRequest: () => Effect.die(new Error("lookup unavailable")),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toEqual([]);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles an overdue unlinked branch thread only after an empty PR lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("overdue-no-pr", { branch: "feature" });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
          branchPullRequest: () => Effect.succeed(null),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.branchCalls)).toHaveLength(1);
          expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
            thread.id,
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("settles unchanged threads when their inactivity deadline passes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("deadline", {
          latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS + 30_000),
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          expect(yield* Ref.get(fixture.commands)).toHaveLength(0);
          yield* TestClock.adjust("1 minute");
          yield* service.drain;
          expect(yield* Ref.get(fixture.commands)).toHaveLength(1);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a merged branch PR that cannot settle its thread rereads no git state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const freshReads = yield* Ref.make(0);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([
            makeThread("worked-after-merge", {
              branch: "merged-feature",
              latestResumingMessageAt: DateTime.makeUnsafe("2026-08-28T06:00:00.000Z"),
            }),
          ]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: (_input, lookupOptions) =>
            Ref.update(
              freshReads,
              (count) => count + (readsFreshGitState(lookupOptions) ? 1 : 0),
            ).pipe(
              Effect.as({
                ...makeBranchPullRequest("merged"),
                mergedAt: "2026-08-27T00:00:00.000Z",
              }),
            ),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.strictEqual((yield* Ref.get(fixture.branchCalls)).length, 2);
          assert.strictEqual(yield* Ref.get(freshReads), 0);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a remembered merged branch PR settles only after fresh git state agrees", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const freshState = yield* Ref.make<"open" | "merged">("open");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([makeThread("merged-branch", { branch: "merged-feature" })]),
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: (_input, lookupOptions) =>
            readsFreshGitState(lookupOptions)
              ? Ref.get(freshState).pipe(Effect.map(makeBranchPullRequest))
              : Effect.succeed(makeBranchPullRequest("merged")),
        });

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(reactor, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* Ref.set(freshState, "merged");
          // GOAT keeps a group's lookup for two minutes, so the open answer is asked again then.
          yield* TestClock.adjust("2 minutes");
          yield* Queue.take(fixture.snapshotReads);
          yield* reactor.drain;

          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [ThreadId.make("merged-branch")],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
}

import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type OrchestrationV2DomainEvent } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";
import {
  appThread,
  settledEvent,
  shellMergeEvent,
  terminalEvent,
} from "./ThreadSettlementService.admission-test-cases.ts";

const NOW = "2026-08-27T12:00:00.000Z";

const branchResult = (branch: string, refresh = false) => ({
  number: 42,
  title: "Pull request",
  url: "https://example.test/pr/42",
  baseRef: "main",
  headRef: branch,
  state: refresh ? ("merged" as const) : ("open" as const),
  mergedAt: refresh ? NOW : null,
  closedAt: null,
  updatedAt: NOW,
  repositoryKey: "example.test/owner/repository",
});

export function settlementShellHintTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
}: Pick<typeof Harness, "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness">) {
  for (const recovery of ["terminal event", "full sweep"] as const) {
    it.effect(`retains a SQL-excluded shell hint past 256 other hints until ${recovery}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const marker = appThread("excluded-hint-marker", "settled");
          const thread = makeThread("excluded-hint", { branch: "feature" });
          const others = Array.from({ length: 256 }, (_, index) =>
            makeThread(`other-hint-${index}`, {
              branch: `other-${index}`,
              pendingBackgroundTasks: [
                { taskId: "active", kind: "subagent", description: "Review" },
              ],
            }),
          );
          const refreshes = yield* Ref.make<ReadonlyArray<boolean>>([]);
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([thread]),
            currentThreads: [marker, appThread(thread.id, null)],
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
            branchPullRequest: (input, options) =>
              Ref.update(refreshes, (values) => [...values, options?.refresh === true]).pipe(
                Effect.as(branchResult(input.branch, options?.refresh)),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            assert.deepStrictEqual(yield* Ref.get(refreshes), [false]);
            yield* Ref.set(fixture.snapshots, makeSnapshot(others));
            for (const other of others) {
              yield* fixture.publishEvent(shellMergeEvent(other.id));
              yield* fixture.publishEvent(settledEvent(marker));
              yield* Queue.take(fixture.closedIdle);
              yield* service.drain;
            }
            // SQL excludes active runs from targeted reads and full-pass candidates alike.
            yield* Ref.set(fixture.snapshots, makeSnapshot([]));
            yield* fixture.publishEvent(shellMergeEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
            yield* TestClock.adjust("1 minute");
            yield* service.drain;
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
            if (recovery === "terminal event") {
              yield* fixture.publishEvent(terminalEvent(thread.id));
              yield* fixture.publishEvent(settledEvent(marker));
              yield* Queue.take(fixture.closedIdle);
            } else {
              yield* TestClock.adjust("1 minute");
            }
            yield* service.drain;
            assert.deepStrictEqual(yield* Ref.get(refreshes), [false, true]);
            assert.deepStrictEqual(
              (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
              [thread.id],
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );
  }

  it.effect("checks a shell hint's thread without restoring archived history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const marker = appThread("restore-hint-marker", "settled");
        const thread = makeThread("restore-hint", { branch: "feature" });
        const restoringReads = yield* Ref.make<ReadonlyArray<string>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          currentThreads: [marker, appThread(thread.id, null)],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: (input, options) =>
            Effect.succeed(branchResult(input.branch, options?.refresh)),
          onRestoringThreadRead: (threadId) =>
            Ref.update(restoringReads, (reads) => [...reads, threadId]),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.snapshots, makeSnapshot([]));
          yield* fixture.publishEvent(shellMergeEvent(thread.id));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          assert.notInclude(yield* Ref.get(restoringReads), thread.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  for (const type of ["thread.deleted", "thread.archived", "thread.settled"] as const) {
    it.effect(`discards a retained shell hint on ${type}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const marker = appThread("retired-hint-marker", "settled");
          const thread = makeThread("retired-hint", { branch: "feature" });
          const retired = {
            ...appThread(thread.id, type === "thread.settled" ? "settled" : null),
            deletedAt: type === "thread.deleted" ? DateTime.makeUnsafe(NOW) : null,
            archivedAt: type === "thread.archived" ? DateTime.makeUnsafe(NOW) : null,
          };
          const refreshes = yield* Ref.make<ReadonlyArray<boolean>>([]);
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([thread]),
            currentThreads: [marker, appThread(thread.id, null)],
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
            branchPullRequest: (input, options) =>
              Ref.update(refreshes, (values) => [...values, options?.refresh === true]).pipe(
                Effect.as(branchResult(input.branch, options?.refresh)),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* Ref.set(fixture.snapshots, makeSnapshot([]));
            yield* fixture.publishEvent(shellMergeEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
            yield* Ref.set(fixture.currentThreads, [marker, retired]);
            const event: OrchestrationV2DomainEvent = {
              ...settledEvent(retired),
              type,
              payload: retired,
            };
            yield* fixture.publishEvent(event);
            if (type === "thread.settled") {
              assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), {
                threadId: thread.id,
              });
            }
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            // A late candidate snapshot must not resurrect the retired refresh intent.
            yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
            yield* fixture.publishEvent(terminalEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
            assert.deepStrictEqual(yield* Ref.get(refreshes), [false, false]);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
            yield* Ref.set(fixture.snapshots, makeSnapshot([]));
            yield* fixture.publishEvent(shellMergeEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
            yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
            yield* fixture.publishEvent(terminalEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
            assert.deepStrictEqual(yield* Ref.get(refreshes), [false, false, false]);
            assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
    );
  }
}

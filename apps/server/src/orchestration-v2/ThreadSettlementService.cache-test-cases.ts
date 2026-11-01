import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

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
          yield* TestClock.adjust("1 minute");
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
          yield* TestClock.adjust("1 minute");
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
}

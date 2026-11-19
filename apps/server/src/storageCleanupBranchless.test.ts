import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { NOW_MS, DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import {
  LEGACY_WORKTREE_RULES,
  cleanupFixture,
  cleanupTestLayer,
} from "./storageCleanup.testkit.ts";

describe("branchless worktree cleanup", () => {
  it.effect.each(["completed", "running"] as const)(
    "keeps the worktree and reports %s state",
    (status) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setSettings({
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            ...LEGACY_WORKTREE_RULES,
            worktreeSettledAfterDays: 8,
            worktreeAfterDays: null,
          },
        });
        fixture.setThreads([
          shell({
            branch: null,
            worktreePath: fixture.worktree,
            settledAt: at(-20 * DAY_MS),
            status,
          }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            status === "running" ? "Thread is running or has pending work" : "Thread has no branch",
        });
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

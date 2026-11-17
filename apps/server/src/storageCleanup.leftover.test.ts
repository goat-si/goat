import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { at, DAY_MS, NOW_MS, shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// A failed `git worktree remove` can leave dependencies behind without the checkout.
it.effect("keeps a thread's worktree folder that lost its .git link", () =>
  runCleanupTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: at(-DAY_MS) }),
      ]);
      yield* fixture.fs.remove(`${fixture.worktree}/.git`);
      yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`);
      const report = yield* fixture.service.runNow;
      expect(report.entries).toEqual([
        expect.objectContaining({ path: fixture.worktree, outcome: "kept" }),
      ]);
      expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
    }),
  ),
);

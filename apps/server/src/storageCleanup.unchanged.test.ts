import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live("keeps an unsettled new thread's unchanged worktree after its first turn", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, setThreads } = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeSettledAfterDays: 11,
        worktreeOnMerge: true,
        worktreeUnchanged: true,
      });
      const now = yield* DateTime.now;
      const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });
      const thread = shell({
        branch: "feature",
        worktreePath: worktree,
        status: "completed",
        createdAt: minutesAgo(40),
        latestUserMessageAt: minutesAgo(40),
        latestRunRequestedAt: minutesAgo(40),
        latestRunStartedAt: minutesAgo(40),
        latestRunCompletedAt: minutesAgo(20),
        updatedAt: minutesAgo(20),
      });
      setThreads([thread]);

      const report = yield* service.runNow;
      expect(report.entries[0]).toMatchObject({ outcome: "kept" });
      expect(yield* fs.exists(worktree)).toBe(true);

      setThreads([{ ...thread, settledAt: minutesAgo(10), updatedAt: minutesAgo(10) }]);
      const settled = yield* service.runNow;
      expect(settled.entries[0]).toMatchObject({
        outcome: "removed",
        reason: "No commits beyond the project branch",
      });
    }),
  ),
);

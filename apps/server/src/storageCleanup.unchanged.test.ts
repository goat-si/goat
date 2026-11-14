import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { shell } from "./storageCleanup.testFixtures.ts";
import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

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

it.live("keeps an unsettled thread's unchanged worktree without asking its remote", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, command, setThreads } = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        ...LEGACY_WORKTREE_RULES,
        worktreeUnchanged: true,
      });
      // Any ls-remote or fetch against this remote fails, which would report unknown shipping.
      yield* command(repo, ["remote", "add", "origin", `${repo}-missing-remote`]);
      setThreads([shell({ branch: "feature", worktreePath: worktree })]);

      const report = yield* service.runNow;
      expect(report.entries[0]).toMatchObject({ outcome: "kept", reason: "Not settled" });
      expect(yield* fs.exists(worktree)).toBe(true);
    }),
  ),
);

import { expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";
import { at, DAY_MS, shell } from "./storageCleanup.testFixtures.ts";

it.live("keeps an annex worktree held by a live thread", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, worktree, fs, command } = fixture;
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* fs.remove(`${worktree}/.git`);
      yield* fs.symlink(admin, `${worktree}/.git`);
      fixture.setDeletedThreads([
        shell({ branch: "feature", worktreePath: worktree, deletedAt: at(-DAY_MS) }),
      ]);
      fixture.setThreads([
        shell({
          id: ThreadId.make("live-holder"),
          branch: "feature",
          worktreePath: worktree,
          activeRunId: RunId.make("active"),
        }),
      ]);
      const report = yield* service.runNow;
      expect(
        report.entries.some((entry) => entry.path === worktree && entry.outcome === "removed"),
      ).toBe(false);
      expect(yield* fs.exists(worktree)).toBe(true);
    }),
  ),
);

it.live("removes an annex worktree after verifying its backlink", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, worktree, fs, command } = yield* cleanupFixture();
      const admin = (yield* command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* fs.remove(`${worktree}/.git`);
      yield* fs.symlink(admin, `${worktree}/.git`);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "removed" });
      expect(yield* fs.exists(worktree)).toBe(false);
    }),
  ),
);

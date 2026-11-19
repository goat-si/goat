import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

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

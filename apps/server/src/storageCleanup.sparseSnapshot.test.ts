import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  applySnapshotToWorktree,
  verifyRestoredWorktree,
} from "./orchestration-v2/goat/restoreSnapshot.ts";
import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// On Git 2.37+ an edited file outside a sparse checkout's patterns shows in git status, but a
// plain `git add -A` leaves it out of the snapshot, and cleanup would remove the worktree with it.
it.live("a sparse worktree's edit outside its patterns is in the snapshot and comes back", () =>
  runCleanupTest(
    Effect.gen(function* () {
      // A verified snapshot covers uncommitted work, so cleanup removes the worktree with force.
      const { service, fs, repo, worktree, command } = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        ...LEGACY_WORKTREE_RULES,
        worktreeAfterDays: 8,
        worktreeSnapshotChanges: true,
        worktreeKeepWhen: "uncommitted-changes",
      });
      const sparse = (cwd: string) =>
        command(cwd, ["sparse-checkout", "set", "--no-cone", "/.gitignore"]);
      yield* sparse(worktree);
      yield* fs.writeFileString(`${worktree}/tracked.txt`, "edited outside the patterns\n");
      expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toContain("tracked.txt");
      const report = yield* service.runNow;
      expect(report.entries[0]).toMatchObject({ outcome: "removed" });
      const ref =
        (yield* command(repo, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/goat/snapshots",
        ])).stdout
          .trim()
          .split("\n")[0] ?? "";
      expect((yield* command(repo, ["show", `${ref}:tracked.txt`])).stdout).toBe(
        "edited outside the patterns\n",
      );
      // Restore makes the worktree again with the same patterns and applies the snapshot.
      const snapshotSha = (yield* command(repo, ["rev-parse", ref])).stdout.trim();
      const headSha = (yield* command(repo, ["rev-parse", `${ref}^1`])).stdout.trim();
      yield* command(repo, ["worktree", "add", worktree, "feature"]);
      yield* sparse(worktree);
      yield* applySnapshotToWorktree({ cwd: worktree, snapshotSha });
      yield* verifyRestoredWorktree({
        cwd: worktree,
        branch: "feature",
        expectedHead: headSha,
        snapshot: snapshotSha,
      });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe(
        "edited outside the patterns\n",
      );
    }),
  ),
);

import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { isMissingGitRepository } from "./storageCleanupGitErrors.ts";

export const makeBranchChanged = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
) => {
  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  return Effect.fn("StorageCleanup.branchChanged")(function* (cwd: string, branch: string | null) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (isMissingGitRepository(result.stderr)) return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    // Removal keeps branches but drops a detached HEAD, so only commits held elsewhere are safe.
    if (head.exitCode !== 0) {
      // A paused rebase, merge or bisect would lose its progress (and any autostash) on removal.
      const operations = yield* read([
        "rev-parse",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
        "--git-path",
        "MERGE_HEAD",
        "--git-path",
        "MERGE_AUTOSTASH",
        "--git-path",
        "BISECT_LOG",
      ]);
      if (operations === null) return true;
      for (const state of operations.stdout.trim().split(/\r?\n/)) {
        if (yield* fs.exists(path.resolve(cwd, state))) return true;
      }
      const unreachable = yield* read([
        "rev-list",
        "--max-count=1",
        "HEAD",
        "--not",
        "--branches",
        "--remotes",
      ]);
      return unreachable === null || unreachable.stdout.trim() !== "";
    }
    const ref = head.stdout.trim();
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return name !== branch;
  });
};

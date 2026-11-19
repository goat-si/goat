import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as VcsDriver from "./VcsDriver.ts";
import { checkpointCommitResult } from "./gitRepositoryProbe.ts";

export function makeResolveGitCommonDir(
  execute: VcsDriver.VcsDriver["Service"]["execute"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  // Git reports relative paths from the physical cwd, which can differ from a symlink.
  return Effect.fn("GitVcsDriver.resolveGitCommonDir")(function* (cwd: string) {
    const result = yield* execute({
      operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    const gitCommonDir = result.stdout.trim();
    if (path.isAbsolute(gitCommonDir)) return gitCommonDir;
    const physicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    return path.resolve(physicalCwd, gitCommonDir);
  });
}

export function makeResolveCheckpointCommit(execute: VcsDriver.VcsDriver["Service"]["execute"]) {
  return (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
    }).pipe(Effect.flatMap((result) => checkpointCommitResult(cwd, result)));
}

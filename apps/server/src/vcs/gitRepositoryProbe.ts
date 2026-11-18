import { VcsProcessExitError, type VcsError } from "@goat/contracts";
import { isMissingExecutable } from "@goat/source-control-core/server/discovery";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { VcsProcessOutput } from "./VcsProcess.ts";

export const WORK_TREE_PROBE_OPERATION = "GitVcsDriver.probeWorkTree";
const hasStderrLine = (stderr: string, prefixes: ReadonlyArray<string>) =>
  stderr.split("\n").some((line) => prefixes.some((prefix) => line.startsWith(prefix)));

export const workTreeProbeResult = Effect.fn("GitVcsDriver.probeWorkTree")(function* (
  cwd: string,
  fileSystem: FileSystem.FileSystem,
  command: Effect.Effect<VcsProcessOutput, VcsError>,
) {
  const result = yield* command.pipe(
    Effect.catchIf(isMissingExecutable, () => Effect.succeed(null)),
  );
  if (result === null) return null;
  if (result.exitCode === 0) return result.stdout;
  if (
    result.stdout.startsWith("false") ||
    hasStderrLine(result.stderr, [
      "fatal: not a git repository",
      "fatal: cannot use bare repository",
    ]) ||
    !(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))
  )
    return null;
  return yield* new VcsProcessExitError({
    operation: WORK_TREE_PROBE_OPERATION,
    command: "git rev-parse",
    cwd,
    exitCode: result.exitCode,
    detail: result.stderr.trim() || "git rev-parse failed",
  });
});

export const checkpointCommitResult = (cwd: string, result: VcsProcessOutput) => {
  if (result.exitCode === 1 && !hasStderrLine(result.stderr, ["error:", "fatal:"]))
    return Effect.succeed(null);
  if (result.exitCode !== 0)
    return Effect.fail(
      new VcsProcessExitError({
        operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
        command: "git rev-parse",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "git rev-parse failed",
      }),
    );
  return Effect.succeed(result.stdout.trim() || null);
};

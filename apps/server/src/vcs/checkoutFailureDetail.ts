import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitCommandContext } from "./gitCommandContext.ts";
import { classifyGitFailure } from "./gitFailureClassification.ts";

export function checkCheckoutResult(
  cwd: string,
  args: readonly string[],
  result: GitVcsDriver.ExecuteGitResult,
) {
  if (result.exitCode === 0) return Effect.void;
  const reason = classifyGitFailure(result.stderr);
  return Effect.fail(
    new GitCommandError({
      ...gitCommandContext({ operation: "GitVcsDriver.switchRef.checkout", cwd, args }),
      ...(reason === null ? {} : { reason }),
      detail:
        /^error: Your local changes to the following files would be overwritten by checkout:/m.test(
          result.stderr,
        )
          ? "Your local changes would be overwritten by switching branches. Commit, stash, or discard them, then switch again."
          : "git checkout failed",
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length,
    }),
  );
}

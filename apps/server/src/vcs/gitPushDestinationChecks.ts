import * as Effect from "effect/Effect";
import type { GitCommandError } from "@goat/contracts";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

export function makeRemoteRefContainsHead(
  executeGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: { readonly allowNonZeroExit: boolean },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) {
  const remoteRefContainsHead = (cwd: string, remoteRef: string) =>
    executeGit(
      "GitVcsDriver.pushCurrentBranch.publishContainsHead",
      cwd,
      ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/${remoteRef}`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  return remoteRefContainsHead;
}

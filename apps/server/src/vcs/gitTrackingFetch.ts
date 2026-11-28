import { GitCommandError } from "@goat/contracts";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";
import { gitCommandContext } from "./gitCommandContext.ts";
import { classifyGitFailure, gitFailureDetail } from "./gitFailureClassification.ts";
import { fetchFailureDetail } from "./gitRemoteParsing.ts";

export const trackingFetchArgs = (input: { remoteName: string; remoteBranch: string }) => [
  "fetch",
  "--quiet",
  "--no-tags",
  "--no-auto-gc",
  "--",
  input.remoteName,
  `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
];

export function trackingFetchError(cwd: string, args: string[], result: ExecuteGitResult) {
  const reason = classifyGitFailure(result.stderr);
  return new GitCommandError({
    ...gitCommandContext({ operation: "GitVcsDriver.fetchRemoteTrackingBranch", cwd, args }),
    ...(reason === null ? {} : { reason }),
    detail: fetchFailureDetail(result.stderr) ?? gitFailureDetail(reason),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    stdoutLength: result.stdout.length,
    stderrLength: result.stderr.length,
  });
}

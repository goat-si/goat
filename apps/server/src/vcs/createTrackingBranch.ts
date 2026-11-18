import type { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

export function trackingCheckoutTarget(input: {
  refName: string;
  localInputExists: boolean;
  remoteExists: boolean;
  localTrackingBranch: string | null;
  localTrackedBranchTargetExists: boolean;
  localTrackedBranchCandidate: string | null;
}) {
  const {
    refName,
    localInputExists,
    remoteExists,
    localTrackingBranch,
    localTrackedBranchTargetExists,
    localTrackedBranchCandidate,
  } = input;
  const branch =
    !localInputExists && remoteExists && !localTrackingBranch && !localTrackedBranchTargetExists
      ? localTrackedBranchCandidate
      : null;
  const args = localInputExists
    ? ["checkout", refName]
    : branch
      ? ["checkout", branch]
      : remoteExists && !localTrackingBranch
        ? ["checkout", "--track", refName]
        : remoteExists && localTrackingBranch
          ? ["checkout", localTrackingBranch]
          : ["checkout", refName];
  return { branch, args };
}

export const createTrackingBranch = (
  cwd: string,
  branch: string | null,
  upstream: string,
  executeGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: {
      timeoutMs: number;
      fallbackErrorDetail?: string;
      writesSharedConfig?: boolean;
      retryConfigLock?: boolean;
    },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) => {
  // A failed checkout can have moved HEAD already, so keep a branch created here.
  if (branch === null) return Effect.void;
  const startRef = `refs/remotes/${upstream}`;
  return Effect.gen(function* () {
    const { stdout } = yield* executeGit(
      "GitVcsDriver.switchRef.resolveTrackingStart",
      cwd,
      ["rev-parse", "--verify", `${startRef}^{commit}`],
      { timeoutMs: 5_000 },
    );
    const startCommit = stdout.trim();
    yield* executeGit(
      "GitVcsDriver.switchRef.createTrackingBranch",
      cwd,
      ["branch", "--no-track", "--", branch, startCommit],
      { timeoutMs: 10_000, fallbackErrorDetail: "git branch create failed" },
    );
    yield* executeGit(
      "GitVcsDriver.switchRef.trackRemote",
      cwd,
      ["branch", `--set-upstream-to=${startRef}`, "--", branch],
      {
        timeoutMs: 10_000,
        fallbackErrorDetail: "git branch --set-upstream-to failed",
        writesSharedConfig: true,
        retryConfigLock: true,
      },
    ).pipe(
      // A racing fetch can move startRef; delete only the exact commit this call installed.
      Effect.tapError(() =>
        executeGit(
          "GitVcsDriver.switchRef.removeUntrackedBranch",
          cwd,
          ["update-ref", "-d", `refs/heads/${branch}`, startCommit],
          { timeoutMs: 5_000 },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove untracked branch after upstream setup failed", {
              cwd,
              branch,
              reason: error.reason,
              exitCode: error.exitCode,
            }),
          ),
        ),
      ),
    );
  });
};

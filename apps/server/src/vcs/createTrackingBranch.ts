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
      allowNonZeroExit?: boolean;
    },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) => {
  // A failed checkout can have moved HEAD already, so keep a branch created here.
  if (branch === null) return Effect.void;
  // A tag sharing the remote ref's name wins a short-name lookup, so start from the full ref.
  const startRef = `refs/remotes/${upstream}`;
  return executeGit(
    "GitVcsDriver.switchRef.createTrackingBranch",
    cwd,
    ["branch", "--no-track", "--", branch, startRef],
    { timeoutMs: 10_000, fallbackErrorDetail: "git branch create failed" },
  ).pipe(
    Effect.andThen(
      executeGit(
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
        // An untracked branch of this name would make every later switch to the remote detach.
        Effect.tapError(() =>
          executeGit(
            "GitVcsDriver.switchRef.removeUntrackedBranch",
            cwd,
            ["update-ref", "-d", `refs/heads/${branch}`, startRef],
            { timeoutMs: 5_000, allowNonZeroExit: true },
          ).pipe(Effect.ignore),
        ),
      ),
    ),
    Effect.asVoid,
  );
};

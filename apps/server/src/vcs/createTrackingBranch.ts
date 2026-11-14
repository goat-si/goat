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
    options: { timeoutMs: number; fallbackErrorDetail: string; writesSharedConfig: boolean },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) =>
  // A failed checkout can have moved HEAD already, so keep a branch created here.
  branch === null
    ? Effect.void
    : executeGit(
        "GitVcsDriver.switchRef.createTrackingBranch",
        cwd,
        ["branch", "--track", "--", branch, upstream],
        {
          timeoutMs: 10_000,
          fallbackErrorDetail: "git branch create failed",
          writesSharedConfig: true,
        },
      ).pipe(Effect.asVoid);

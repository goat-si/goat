import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export interface GitRemoteStatusOptions extends GitVcsDriver.GitRemoteStatusOptions {
  readonly refreshMissingPullRequest?: boolean;
  /** Details the caller just read without fetching; used instead of reading them again. */
  readonly statusDetails?: GitVcsDriver.GitRemoteStatusDetails;
}

export interface GitLocalStatusOptions {
  /** Defaults to true. The branch-wide totals cost about half of a local status read. */
  readonly includeBranchChanges?: boolean;
}

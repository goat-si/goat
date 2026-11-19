export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

/** Where `pushCurrentBranch` would send the checked-out branch. */
export interface GitPushTarget {
  remoteName: string;
  branchName: string;
}

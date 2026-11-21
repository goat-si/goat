import type * as GitVcsDriver from "./GitVcsDriver.ts";

export const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});
export const NON_REPOSITORY_REMOTE_STATUS_DETAILS =
  Object.freeze<GitVcsDriver.GitRemoteStatusDetails>({
    isRepo: false,
    defaultBranch: null,
    isDefaultBranch: false,
    branch: null,
    upstreamRef: null,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
  });

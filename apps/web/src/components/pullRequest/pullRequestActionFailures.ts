import type { PullRequestAction } from "@goat/contracts";

export const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: `Could not merge this ${term}`,
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: `Could not close this ${term}`,
  reopen: `Could not reopen this ${term}`,
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
  revert: `Could not open a revert ${term}`,
  "delete-branch": "Could not delete this branch",
  "approve-workflows": "Could not approve workflows",
});

export const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "The host refused it. Check that you have write access to the branch (a fork branch also needs its author to allow edits from maintainers), and that it does not conflict with the base.",
  "enable-auto-merge":
    "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge":
    "The host refused it. Check that you have write access, and that the merge has not already happened.",
  revert: `The host refused it. Check that you have write access and that this ${term} was merged on the host.`,
  "delete-branch":
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
});

export const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

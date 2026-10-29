import type { PullRequestAction } from "@goat/contracts";

export const ACTION_ACCESS_REFUSALS: Record<PullRequestAction, string> = {
  merge: "You need write access on this repository to merge.",
  ready:
    "You need write access on this repository, or to have opened this change request, to mark it ready for review.",
  draft:
    "You need write access on this repository, or to have opened this change request, to return it to a draft.",
  close:
    "You need write access on this repository, or to have opened this change request, to close it.",
  "update-branch":
    "You need write access on this repository, or to have opened this change request, to update its branch.",
  reopen:
    "You need write access on this repository, or to have opened this change request, to reopen it.",
  "enable-auto-merge":
    "Auto-merge needs write access on this repository, and the repository has to allow it.",
  "disable-auto-merge":
    "You need write access on this repository to stop it being merged for you once it is ready.",
  revert: "You need write access on this repository to open a revert pull request.",
  "delete-branch": "You need write access on the source repository to delete its branch.",
  "approve-workflows":
    "You need write access on this repository to approve workflows from a fork pull request.",
};

import type { PullRequestAction, PullRequestMergeMethod } from "@goat/contracts";

export function actionArgs(
  action: PullRequestAction,
  mergeMethod: PullRequestMergeMethod | undefined,
): ReadonlyArray<string> {
  switch (action) {
    case "merge":
      return [
        "merge",
        // glab defaults to auto-merge during a running pipeline.
        "--auto-merge=false",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "enable-auto-merge":
      return [
        "merge",
        "--auto-merge=true",
        "--yes",
        ...(mergeMethod === "squash" ? ["--squash"] : []),
      ];
    case "disable-auto-merge":
      return [];
    case "ready":
      return ["update", "--ready"];
    case "draft":
      return ["update", "--draft"];
    case "close":
      return ["close"];
    case "update-branch":
      return ["rebase"];
    case "reopen":
      return ["reopen"];
    case "revert":
    case "approve-workflows":
    case "delete-branch":
      throw new Error(`GitLab merge request action ${action} is unsupported`);
  }
}

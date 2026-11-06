import type { PullRequestMergeMethod } from "@goat/contracts";

export function toMergeMethod(
  value: string | null | undefined,
): PullRequestMergeMethod | undefined {
  switch (value?.trim().toUpperCase()) {
    case "MERGE":
      return "merge";
    case "SQUASH":
      return "squash";
    case "REBASE":
      return "rebase";
    default:
      return undefined;
  }
}

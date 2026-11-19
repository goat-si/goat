import type { PullRequestListState } from "@goat/contracts";
import type { GitHubPullRequestListItem } from "./gitHubPullRequestJson.ts";

export const LIST_STATES: Record<
  PullRequestListState,
  ReadonlyArray<"OPEN" | "CLOSED" | "MERGED">
> = {
  all: ["OPEN", "CLOSED", "MERGED"],
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
};

export interface GitHubPullRequestListPage<Item = GitHubPullRequestListItem> {
  readonly items: ReadonlyArray<Item>;
  readonly rawCount: number;
  readonly endCursor: string | null;
}

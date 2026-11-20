import type { PullRequestsByHead } from "./sourceControlProvider.graphql.ts";

export type PullRequestListState = "open" | "closed" | "merged" | "all";

export const GRAPHQL_STATES: Record<
  PullRequestListState,
  NonNullable<PullRequestsByHead.Variables["states"]>
> = {
  open: ["OPEN"],
  closed: ["CLOSED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
};

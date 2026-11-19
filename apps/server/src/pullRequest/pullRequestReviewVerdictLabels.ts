import type { PullRequestReviewVerdict } from "@goat/contracts";

export const VERDICT_LABELS: Record<PullRequestReviewVerdict, string> = {
  comment: "review",
  approve: "approve",
  "request-changes": "request changes on",
};

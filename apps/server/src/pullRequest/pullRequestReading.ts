import type { PullRequestSummary } from "@goat/contracts";

export type PullRequestReading = Pick<
  PullRequestSummary,
  "state" | "isDraft" | "updatedAt" | "observedAt"
>;

function supersedesReading(current: PullRequestReading | undefined, next: PullRequestReading) {
  if (current === undefined) return true;
  if (current.state === "merged" && next.state !== "merged") return false;
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  return (next.observedAt ?? -Infinity) >= (current.observedAt ?? -Infinity);
}

export { supersedesReading };

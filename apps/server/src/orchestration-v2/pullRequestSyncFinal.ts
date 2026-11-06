import type { ThreadPullRequestSnapshot } from "@goat/contracts";

export function isFinalPullRequestSnapshot(
  snapshot: ThreadPullRequestSnapshot | null,
  nowMs: number,
): boolean {
  return snapshot?.state === "merged"
    ? snapshot.mergedAt != null
    : snapshot?.state === "closed" &&
        nowMs - Date.parse(snapshot.closedAt ?? "") >= 24 * 60 * 60 * 1_000;
}

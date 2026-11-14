import type { ThreadPullRequestSnapshot } from "@goat/contracts";

/**
 * A thread whose links PullRequestSyncReactor keeps due. Once every thread holding a link is
 * settled, its snapshot is no longer refreshed; GOAT Bot's work rows read the same rule.
 */
export function isPullRequestSyncUnsettled(thread: {
  readonly settledOverride: string | null;
  readonly settledAt: unknown;
}): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

export function isFinalPullRequestSnapshot(
  snapshot: Pick<ThreadPullRequestSnapshot, "state" | "closedAt" | "mergedAt"> | null,
  nowMs: number,
): boolean {
  return snapshot?.state === "merged"
    ? snapshot.mergedAt != null
    : snapshot?.state === "closed" &&
        nowMs - Date.parse(snapshot.closedAt ?? "") >= 24 * 60 * 60 * 1_000;
}

import type { RunId } from "@goat/contracts";
import type { ThreadFeedEntry, ThreadFeedLatestRun } from "./threadActivityTypes";

export function latestRunsEqual(
  left: ThreadFeedLatestRun | null,
  right: ThreadFeedLatestRun | null,
) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.runId === right.runId &&
      left.status === right.status &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.turnEnded === right.turnEnded &&
      left.providerStartingLabel === right.providerStartingLabel)
  );
}

export function feedEntryRunId(entry: ThreadFeedEntry): RunId | null {
  return entry.type === "message" ? (entry.message.runId ?? null) : entry.runId;
}

export function isUserMessageEntry(entry: ThreadFeedEntry | undefined): boolean {
  return entry?.type === "message" && entry.message.role === "user";
}

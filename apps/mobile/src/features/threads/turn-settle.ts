import { threadFeedRunIsUnsettled, type ThreadFeedLatestRun } from "../../lib/threadActivity";
import type { FloatingWorkingStatus } from "./floating-working-status";
import type { ThreadFeedRow } from "./pending-thread-feed";

/** Live work ends with the provider turn; the feed drops its live row then, though the run settles later. */
export function workingFloatingStatus(
  activeWorkStartedAt: string | null,
  latestRun: Pick<ThreadFeedLatestRun, "turnEnded"> | null,
): FloatingWorkingStatus | null {
  return activeWorkStartedAt === null || latestRun?.turnEnded === true
    ? null
    : { kind: "working", startedAt: activeWorkStartedAt };
}

/** Stop interrupts generation; once the provider turn ends, the run only settles. */
export function turnCanStop(
  interruptibleRunId: string | null,
  latestRun: Pick<ThreadFeedLatestRun, "turnEnded"> | null,
) {
  return interruptibleRunId !== null && latestRun?.turnEnded !== true;
}

/** A run's work folds when it settles; its final reply is where the reader's place is kept. */
export function settledRunAnchorId(
  previous: ThreadFeedLatestRun | null,
  latest: ThreadFeedLatestRun | null,
  rows: ReadonlyArray<ThreadFeedRow>,
): string | null {
  if (previous === null || latest === null || previous.runId !== latest.runId) return null;
  const { runId } = latest;
  if (!threadFeedRunIsUnsettled(previous) || threadFeedRunIsUnsettled(latest)) return null;
  const reply = rows.findLast(
    (row) =>
      row.type === "message" && row.message.role === "assistant" && row.message.runId === runId,
  );
  return reply?.id ?? null;
}

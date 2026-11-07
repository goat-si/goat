import type { ThreadRunSummary } from "@goat/client-runtime/state/shell";
import type { RunId } from "@goat/contracts";

type LatestRun = Pick<ThreadRunSummary, "runId" | "status" | "completedAt" | "turnEnded">;

// The run stays open while the server settles it, but nothing generates once its provider turn ends.
function providerTurnEnded(latestRun: LatestRun | null, runningRunId: RunId | null) {
  return (
    latestRun?.turnEnded === true && (runningRunId === null || runningRunId === latestRun.runId)
  );
}

/** Whether the timeline shows live work: Working, Thinking and unfolded active turns. */
export function timelineIsWorking(input: {
  readonly isWorking: boolean;
  readonly latestRun?: LatestRun | null | undefined;
  readonly runningRunId?: RunId | null | undefined;
}): boolean {
  return input.isWorking && !providerTurnEnded(input.latestRun ?? null, input.runningRunId ?? null);
}

// After send, the previous turn stays active until the server creates its replacement.
export function deriveUnsettledRunId(
  latestRun: LatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (providerTurnEnded(latestRun, runningRunId)) return null;
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

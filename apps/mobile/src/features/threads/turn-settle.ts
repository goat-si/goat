import type { ThreadFeedLatestRun } from "../../lib/threadActivity";
import type { FloatingWorkingStatus } from "./floating-working-status";

/** Live work ends with the provider turn; the feed drops its live row then, though the run settles later. */
export function workingFloatingStatus(
  activeWorkStartedAt: string | null,
  latestRun: Pick<ThreadFeedLatestRun, "turnEnded"> | null,
): FloatingWorkingStatus | null {
  return activeWorkStartedAt === null || latestRun?.turnEnded === true
    ? null
    : { kind: "working", startedAt: activeWorkStartedAt };
}

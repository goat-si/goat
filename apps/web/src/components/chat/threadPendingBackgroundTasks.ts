import type { ThreadStructure } from "@goat/client-runtime/state/shell";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@goat/shared/orchestrationV2ThreadError";

// Excludes `waiting`: that is post-terminal checkpoint drain, so its agent turn is over.
const LIVE_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running"]);

/**
 * Background work the provider still runs after an earlier run ended. It
 * stays listed while a later run is live; that live run's own items are its
 * foreground work, so they never count as background. The provider roster is
 * not run-tied, so it drops entries naming a live run's item by native id.
 */
export function deriveThreadPendingBackgroundTasks(projection: ThreadStructure | null) {
  if (projection === null) return [];
  const sessionError =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const liveRunIds = new Set(
    projection.runs.filter((run) => LIVE_RUN_STATUSES.has(run.status)).map((run) => run.id),
  );
  const foregroundTaskIds = new Set<string>();
  for (const item of projection.turnItems) {
    if (item.runId === null || !liveRunIds.has(item.runId)) continue;
    if (item.nativeItemRef?.nativeId) foregroundTaskIds.add(item.nativeItemRef.nativeId);
  }
  const latestRun =
    usageLimitRunPresentedAsLatest(projection.runs, projection.turnItems, sessionError) ??
    latestUnheldRun(projection.runs.filter((run) => !liveRunIds.has(run.id)));
  return [
    ...derivePendingBackgroundWork({
      latestRun,
      providerThreads: projection.providerThreads.map((thread) => ({
        ...thread,
        pendingBackgroundTasks: thread.pendingBackgroundTasks?.filter(
          (task) => !foregroundTaskIds.has(task.taskId),
        ),
      })),
      turnItems: projection.turnItems.filter(
        (item) => item.runId === null || !liveRunIds.has(item.runId),
      ),
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      hasActiveRun: false,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  ];
}

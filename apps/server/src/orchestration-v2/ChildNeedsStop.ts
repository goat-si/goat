import { isOrchestrationV2WorkActive } from "@goat/contracts";
import { derivePendingBackgroundWork } from "@goat/shared/orchestrationV2PendingBackgroundWork";
import type { ProjectionRecords } from "./ProjectionStore.ts";

// Mirrors what Orchestrator's thread.stop would change; a clause missing here leaves that work running.
export const childNeedsStop = (
  child: ProjectionRecords<"runs" | "providerThreads" | "turnItems" | "subagents">,
): boolean => {
  if (child.thread.deletedAt !== null) return false;
  const latestRun = child.runs.findLast((run) => run.status !== "queued");
  const hasStoppableRun = child.runs.some(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "queued" ||
      run.delegatedCompletion?.delivery != null,
  );
  const hasPendingRecovery =
    latestRun !== undefined &&
    (latestRun.status === "cancelled" ||
      (latestRun.status === "failed" &&
        (latestRun.restartContinuationOfRunId !== undefined ||
          child.thread.limitRecovery?.runId !== latestRun.id ||
          child.thread.limitRecovery.autoResume !== false)));
  const hasPendingSubagent = child.subagents.some(
    (task) =>
      (task.origin === "provider_native" &&
        task.runId !== null &&
        isOrchestrationV2WorkActive(task.status)) ||
      (task.origin === "app_owned" &&
        (isOrchestrationV2WorkActive(task.status) ||
          (task.runId !== null &&
            task.completionDelivery?.state !== "acknowledged" &&
            task.completionDelivery?.state !== "delivered" &&
            task.completionDelivery?.state !== "disposed"))),
  );
  return (
    hasStoppableRun ||
    hasPendingRecovery ||
    child.thread.limitRecovery?.autoResume === true ||
    (child.thread.pullRequests ?? []).some((link) => link.watch !== undefined) ||
    derivePendingBackgroundWork({
      latestRun,
      providerThreads: child.providerThreads,
      turnItems: child.turnItems,
      activeProviderThreadId: child.thread.activeProviderThreadId,
      runs: child.runs,
    }).length > 0 ||
    hasPendingSubagent
  );
};

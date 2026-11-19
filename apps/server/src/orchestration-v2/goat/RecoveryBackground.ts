import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import type * as ProjectionStore from "../ProjectionStore.ts";

export function providerThreadHasPendingBackgroundTasks(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
): boolean {
  return (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
}

export function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

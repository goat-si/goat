import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import { latestUnheldRun } from "@goat/shared/orchestrationV2ThreadError";
import type { ProjectionRecoveryKind } from "./ProjectionStore.ts";
import * as RestartCandidates from "./RestartContinuationCandidates.ts";

export function needsRecovery(
  projection: OrchestrationV2ThreadProjection,
  kind: ProjectionRecoveryKind,
  parent?: Pick<OrchestrationV2ThreadProjection, "subagents" | "contextTransfers">,
): boolean {
  if (projection.thread.deletedAt !== null) return false;
  switch (kind) {
    case "shutdown-continuation":
      return RestartCandidates.isRestartContinuationCandidate(projection);
    case "queued-runs":
      return (
        projection.thread.archivedAt === null &&
        projection.runs.some((run) => run.status === "queued") &&
        !projection.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      );
    case "delegated-completions":
      return projection.runs.some((run) => run.delegatedCompletion?.delivery != null);
    case "subagent-results": {
      const parentThreadId = projection.thread.lineage.parentThreadId;
      return (
        projection.thread.lineage.relationshipToParent === "subagent" &&
        parentThreadId !== null &&
        projection.thread.forkedFrom?.type === "node" &&
        ((parent?.subagents ?? []).some(
          (task) =>
            task.origin === "app_owned" &&
            task.result === null &&
            task.childThreadId === projection.thread.id &&
            projection.runs.some(
              (run) =>
                run.delegatedTaskId === task.id &&
                ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  run.status,
                ),
            ),
        ) ||
          (["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
            latestUnheldRun(projection.runs)?.status ?? "idle",
          ) &&
            ![...projection.contextTransfers, ...(parent?.contextTransfers ?? [])].some(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === projection.thread.id &&
                transfer.targetThreadId === parentThreadId,
            )))
      );
    }
    case "runtime":
    case "runtime-cleanup":
      return (
        projection.runs.some(
          (run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status) ||
            (run.status === "queued" && run.queueHeld !== true),
        ) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.subagents.some(
          (subagent) =>
            (subagent.origin === "provider_native" ||
              (subagent.origin === "app_owned" && subagent.remote !== undefined)) &&
            ["pending", "running", "waiting"].includes(subagent.status),
        ) ||
        projection.providerSessions.some(
          (session) => session.status !== "stopped" && session.status !== "error",
        ) ||
        projection.providerThreads.some(
          (thread) =>
            thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        ) ||
        projection.turnItems.some(
          (item) =>
            ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
            ["pending", "running", "waiting"].includes(item.status) &&
            !projection.runs.some(
              (run) =>
                run.id === item.runId &&
                (kind === "runtime-cleanup"
                  ? run.status === "rolled_back"
                  : ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                      run.status,
                    ) ||
                    (run.status === "queued" && run.queueHeld === true)),
            ),
        )
      );
  }
}

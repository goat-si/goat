import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ProjectionRuntimeRecoveryState,
} from "../ProjectionStore.ts";

export const parentTaskStopped = Effect.fn("ParentTaskStop.check")(function* <E, E2 = never>(
  reader: {
    readonly getThreadRecords: <K extends ProjectionRecordField>(
      threadId: ThreadId,
      fields: ReadonlyArray<K>,
      filter?: ProjectionRecordFilter,
    ) => Effect.Effect<ProjectionRecords<K>, E>;
  },
  projection: Pick<ProjectionRuntimeRecoveryState, "thread">,
  source: OrchestrationV2Run,
  requireActive = false,
  coveredByStop?: (parentThreadId: ThreadId) => Effect.Effect<boolean, E2>,
) {
  // A parent's Stop reaches its open delegated tasks through an effect a restart can cut short.
  const { lineage, forkedFrom } = projection.thread;
  const taskId =
    source.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
  if (
    lineage.relationshipToParent === "subagent" &&
    lineage.parentThreadId !== null &&
    taskId !== undefined
  ) {
    const task = (yield* reader.getThreadRecords(lineage.parentThreadId, ["subagents"], {
      subagentIds: [taskId],
    })).subagents.find((candidate) => candidate.id === taskId);
    // A settled task no longer owns later work in its thread.
    const parentRunId =
      task !== undefined && task.result === null && isOrchestrationV2WorkActive(task.status)
        ? task.runId
        : null;
    if (parentRunId === null && requireActive) return true;
    if (coveredByStop !== undefined) return yield* coveredByStop(lineage.parentThreadId);
    if (
      parentRunId !== null &&
      (yield* reader.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [parentRunId],
      })).turnItems.length > 0
    )
      return true;
  }
  return false;
});

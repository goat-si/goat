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

export const parentTaskStopped = Effect.fn("ParentTaskStop.check")(function* <E>(
  getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, E>,
  projection: Pick<ProjectionRuntimeRecoveryState, "thread">,
  source: OrchestrationV2Run,
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
    const task = (yield* getThreadRecords(lineage.parentThreadId, ["subagents"])).subagents.find(
      (candidate) => candidate.id === taskId,
    );
    // A settled task no longer owns later work in its thread.
    const parentRunId =
      task !== undefined && task.result === null && isOrchestrationV2WorkActive(task.status)
        ? task.runId
        : null;
    if (
      parentRunId !== null &&
      (yield* getThreadRecords(lineage.parentThreadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [parentRunId],
      })).turnItems.length > 0
    )
      return true;
  }
  return false;
});

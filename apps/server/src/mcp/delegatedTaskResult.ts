import type {
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadTimelineItem,
  ThreadId,
} from "@goat/contracts";
import {
  subagentResultForRun,
  subagentStopNotice,
} from "@goat/provider-core/server/subagentProjection";
import { isRetiredWorkspacePreparationFailure } from "../orchestration-v2/preparationItem.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import { isTerminalTaskStatus } from "./taskWaitState.ts";

export function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}
export function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}
type ChildResultRecords = Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers"> &
  Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>;

export function taskResultTransfers(
  parentThreadId: ThreadId,
  child: ChildResultRecords,
  task: OrchestrationV2Subagent,
) {
  const retiredResultItems = new Set(
    (child.turnItems ?? []).filter(isRetiredWorkspacePreparationFailure).map((item) => item.id),
  );
  return child.contextTransfers.filter(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parentThreadId &&
      (transfer.sourcePoint.turnItemId === undefined ||
        !retiredResultItems.has(transfer.sourcePoint.turnItemId)),
  );
}

// The child's transfers include the results it sent, so the parent's transfers are never read.
export function taskResultTransfer(
  parentThreadId: ThreadId,
  child: ChildResultRecords,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return taskResultTransfers(parentThreadId, child, task).findLast(
    (transfer) =>
      (transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
      (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined),
  );
}

export const taskRunResult = (
  projection: Parameters<typeof subagentResultForRun>[0],
  run: OrchestrationV2Run,
) =>
  subagentResultForRun(
    {
      ...projection,
      turnItems: projection.turnItems.filter((item) => !isRetiredWorkspacePreparationFailure(item)),
    },
    run,
  );

export function pageIncludesTerminalTaskResult(input: {
  readonly parentThreadId: ThreadId;
  readonly items: ReadonlyArray<OrchestratorMcpThreadTimelineItem>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
}): boolean {
  const transfer = taskResultTransfer(input.parentThreadId, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = taskRunResult(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  const notice = subagentStopNotice(input.target, run);
  if (
    notice !== undefined &&
    !input.items.some(
      (item) =>
        item.sourceThreadId === input.target.thread.id &&
        item.itemId === notice.id &&
        item.text !== null &&
        !item.textTruncated,
    )
  )
    return false;
  return input.items.some((item) => {
    if (item.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && item.itemId === result.turnItemId) ||
      (result.messageId !== null &&
        item.type === "assistant_message" &&
        item.messageId === result.messageId);
    return matchesResult && item.text !== null && !item.textTruncated;
  });
}

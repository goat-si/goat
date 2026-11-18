import {
  isOrchestrationV2WorkActive,
  type CommandId,
  type NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@goat/contracts";
import { delegatedTaskProgress } from "@goat/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ThreadManagementServiceShape } from "../ThreadManagementService.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import {
  delegatedTaskAwaitsSubagents,
  delegatedTaskResultRun,
  delegatedTaskRuns,
  runOutcome,
} from "../RestartBackgroundNote.ts";

type StopCommand = Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>;

export const DelegatedTaskCancellation = Context.Reference<
  | {
      readonly commandId: CommandId;
      readonly parentThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly stopDescendants: ReturnType<ThreadManagementServiceShape["stopDelegatedTasks"]>;
    }
  | undefined
>("goat/DelegatedTaskCancellation", { defaultValue: () => undefined });

export const readDelegatedTaskCancellation = Effect.fn(
  "Orchestrator.readDelegatedTaskCancellation",
)(function* (command: OrchestrationV2ServerCommand) {
  const cancellation = yield* DelegatedTaskCancellation;
  return command.type === "thread.stop" && command.commandId === cancellation?.commandId
    ? cancellation
    : undefined;
});

export const cancelDelegatedTaskWork = Effect.fn("Orchestrator.cancelDelegatedTaskWork")(function* (
  command: StopCommand,
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
) {
  const cancellation = yield* readDelegatedTaskCancellation(command);
  if (cancellation === undefined) return;
  const { subagents } = yield* projections.getThreadRecords(
    cancellation.parentThreadId,
    ["subagents"],
    { subagentIds: [cancellation.taskId] },
  );
  const task = subagents.find(
    (row) =>
      row.id === cancellation.taskId &&
      row.origin === "app_owned" &&
      row.childThreadId === command.threadId &&
      row.promotedAt === undefined &&
      isOrchestrationV2WorkActive(row.status),
  );
  if (task === undefined) {
    yield* cancellation.stopDescendants;
    return;
  }
  const child = yield* projections.getThreadRecords(
    command.threadId,
    ["runs", "messages", "subagents", "providerThreads"],
    { messageRoles: ["user"] },
  );
  const taskRuns = delegatedTaskRuns(child, task.id);
  // A waiting run has already ended its provider turn. Its outstanding work still holds the task.
  const afterTurn = delegatedTaskProgress({
    ...child,
    runs: child.runs.map((run) =>
      run.status === "waiting" ? { ...run, status: "completed" } : run,
    ),
  });
  const run =
    taskRuns.length > 0
      ? delegatedTaskResultRun(taskRuns)
      : child.thread.forkedFrom?.type === "node" && child.thread.forkedFrom.nodeId === task.id
        ? afterTurn.resultRun
        : undefined;
  const waitingForWork =
    taskRuns.length > 0
      ? run?.status === "waiting" || delegatedTaskAwaitsSubagents(taskRuns, child.subagents)
      : afterTurn.state === "waiting_for_children";
  yield* cancellation.stopDescendants;
  if (run === undefined || !waitingForWork) return;
  return { ...task, cancelledRunId: run.id, updatedAt: yield* DateTime.now };
});

export function delegatedTaskRunOutcome(run: OrchestrationV2Run, task: OrchestrationV2Subagent) {
  const outcome = runOutcome(run);
  return outcome === "completed" && task.cancelledRunId === run.id ? "interrupted" : outcome;
}

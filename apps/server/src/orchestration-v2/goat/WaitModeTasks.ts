import {
  isTerminalDelegatedTaskStatus,
  type OrchestrationV2Subagent,
  type RunId,
} from "@goat/contracts";

export function waitModeTasks(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  run: { readonly id: RunId },
) {
  const waitTasks = subagents.filter(
    (task) =>
      task.origin === "app_owned" &&
      task.runId === run.id &&
      (task.completionWake ?? "settled_only") === "settled_only",
  );
  const waitChildThreadIds = waitTasks.flatMap((task) =>
    task.childThreadId === null || isTerminalDelegatedTaskStatus(task.status)
      ? []
      : [task.childThreadId],
  );
  return { waitTasks, waitChildThreadIds };
}

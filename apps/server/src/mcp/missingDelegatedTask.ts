import {
  OrchestratorMcpFailure,
  type NodeId,
  type ThreadId,
  type OrchestrationV2Subagent,
} from "@goat/contracts";

export function missingDelegatedTask(
  threadId: ThreadId,
  taskId: NodeId,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
) {
  const open = tasks.filter(
    (task) =>
      task.origin === "app_owned" && (task.childThreadId !== null || task.remote !== undefined),
  );
  const listed = open
    .slice(0, 10)
    .map((task) => (task.title ? `${task.id} (${task.title})` : task.id))
    .join(", ");
  const more = open.length > 10 ? `, and ${open.length - 10} more` : "";
  return new OrchestratorMcpFailure({
    code: "task_not_found",
    message:
      `No delegated task with id ${taskId} exists on thread ${threadId}. ` +
      (open.length === 0
        ? "This thread has no open delegated tasks."
        : `Open delegated tasks on this thread: ${listed}${more}.`),
  });
}

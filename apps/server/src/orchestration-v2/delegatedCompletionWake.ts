import type { OrchestrationV2Subagent } from "@goat/contracts";

const DELEGATED_RESULT_INLINE_BYTES = 16_000;

export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): string {
  let remainingBytes = DELEGATED_RESULT_INLINE_BYTES;
  return taskIds
    .map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const label = `Delegated task ${taskId}${task?.title == null ? "" : ` (${task.title})`}${task === undefined ? " reached a terminal state" : ` [${task.status}]`}`;
      if (task?.result != null) {
        const detail = `${label}:\n${task.result}`;
        const bytes = Buffer.byteLength(detail);
        if (bytes <= remainingBytes) {
          remainingBytes -= bytes;
          return detail;
        }
      }
      return `${label}. Read the result with goat_call {path: "task.read", args: {taskId: "${taskId}"}}.`;
    })
    .join("\n\n");
}

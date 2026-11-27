import { ThreadId, type NodeId, type OrchestrationV2Subagent } from "@goat/contracts";

export function completionTask(
  task: OrchestrationV2Subagent,
  id: NodeId,
  result: string,
  status: "failed" | "cancelled",
) {
  return {
    ...task,
    id,
    result,
    status,
    title: "Inspect regression",
    childThreadId: ThreadId.make(`thread:inline-budget-child:${id}`),
  };
}

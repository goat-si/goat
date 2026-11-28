import type { OrchestrationV2ExecutionNode } from "./orchestrationV2.ts";

export function isOrchestrationV2WorkActive(
  status: OrchestrationV2ExecutionNode["status"],
): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

import type { ActiveAcpTurn } from "./adapter.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import { acpSubagentStatusBlocksTurnSettlement } from "./acpSubagentStatus.ts";
import { toolStatus } from "./subagentToolProjection.ts";

export function hasAcpDeferredBackgroundWork(
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  requestCount: number,
): boolean {
  if (flavor.toolOutlivesPrompt !== undefined) {
    for (const tool of context.tools.values()) {
      if (toolStatus(tool.status) === "running" && flavor.toolOutlivesPrompt(tool)) return true;
    }
  }
  if (flavor.wakeOnDetachedRequest && requestCount > 0) return true;
  if (context.awaitingBackgroundHydration.size > 0 || context.pendingInjectedReport.size > 0)
    return true;
  for (const [taskId, toolCallId] of context.toolCallIdsByBackgroundTaskId) {
    if (context.persistentBackgroundTaskIds.has(taskId)) continue;
    const tool = context.tools.get(toolCallId);
    if (tool === undefined) continue;
    const status = toolStatus(tool.status);
    if (status === "pending" || status === "running") return true;
  }
  if (flavor.subagentsIdleOnTurnCompletion === true) return false;
  return [...context.subagents.values()].some((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
}

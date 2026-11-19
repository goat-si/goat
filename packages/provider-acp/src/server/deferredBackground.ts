import * as Effect from "effect/Effect";
import type { AcpAdapterV2SubagentUpdate } from "./adapterFlavor.ts";
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
  if (
    flavor.subagentsIdleOnTurnCompletion === true &&
    flavor.subagentsOutlivingPrompt === undefined
  )
    return false;
  return [...context.subagents.values()].some((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
}

export const idleReportedSubagents = Effect.fn("AcpAdapterV2.idleReportedSubagents")(function* (
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  emit: (context: ActiveAcpTurn, update: AcpAdapterV2SubagentUpdate) => Effect.Effect<void>,
) {
  if (flavor.subagentsOutlivingPrompt === undefined) return;
  const nativeTaskId = (
    subagent: typeof context.subagents extends Map<string, infer V> ? V : never,
  ) => subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
  const running = [...context.subagents.values()].filter((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
  if (running.length === 0) return;
  const atWork = yield* flavor.subagentsOutlivingPrompt({
    sessionId: context.nativeThreadId,
    nativeTaskIds: running.map(nativeTaskId),
  });
  if (context.finalized) return;
  for (const subagent of running) {
    if (
      atWork.includes(nativeTaskId(subagent)) ||
      !acpSubagentStatusBlocksTurnSettlement(subagent.task.status)
    )
      continue;
    yield* emit(context, {
      nativeTaskId: nativeTaskId(subagent),
      prompt: subagent.task.prompt,
      title: subagent.task.title,
      model: subagent.task.model,
      status: "idle",
      childSessionId: subagent.childSessionId,
      result: null,
    });
  }
});

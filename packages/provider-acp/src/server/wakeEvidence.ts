import type * as EffectAcpSchema from "effect-acp/compat";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import {
  acpContentBlockDisplayText,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import { toolStatus } from "./subagentToolProjection.ts";

export function acpRootSessionUpdateIngestsOutput(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (acpContentBlockDisplayText(update.content)?.length ?? 0) > 0;
    case "agent_message":
    case "agent_thought":
      return (update.content ?? []).some(
        (content) => (acpContentBlockDisplayText(content)?.length ?? 0) > 0,
      );
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "compaction_update":
    case "compaction_summary_chunk":
      return parseSessionUpdateEvent(notification).events.some(
        (event) => event._tag === "ToolCallUpdated" || event._tag === "PlanUpdated",
      );
    default:
      return false;
  }
}

export const isAcpMonitorChatter = (text: string) =>
  /^\s*(?:<monitor-event\s|Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended)/i.test(text);

export function acpPostSettleWakeEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation"> = {},
): boolean {
  if (!acpRootSessionUpdateIngestsOutput(notification)) return false;
  const update = notification.update;
  if (
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk") &&
    update.content.type === "text"
  ) {
    const text = update.content.text;
    if ((flavor.extractBackgroundToolMutation?.(text) ?? []).length > 0) return false;
    if (update.sessionUpdate === "agent_message_chunk" && text.trim().length === 0) return false;
    if (isAcpMonitorChatter(text)) return false;
  }
  return true;
}

/** Still-running tool updates can outlast the quiet window; they must not offer completion wakes. */
export function acpPostSettleContinuationOfferEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation" | "normalizeToolCall"> = {},
): boolean {
  if (!acpPostSettleWakeEvidence(notification, flavor)) {
    return false;
  }
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk") {
    return (acpContentBlockDisplayText(update.content)?.trim().length ?? 0) > 0;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return parseSessionUpdateEvent(notification).events.some((event) => {
      if (event._tag !== "ToolCallUpdated") return false;
      // Grok monitor start ACKs say completed while the task is still running.
      const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
      return toolCall.status === "completed" || toolCall.status === "failed";
    });
  }
  return false;
}

export function acpPostSettleWakeShouldBuffer(
  notification: EffectAcpSchema.SessionNotification,
  backgroundWorkRunning: boolean,
): boolean {
  if (!backgroundWorkRunning) return true;
  const update = notification.update;
  return (
    update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk"
  );
}

/**
 * An app-owned wake (a delegated child finishing) is injected by the
 * orchestrator, not typed by the user. It reports on a sibling child and says
 * nothing about this session's own pending wake frames, so it must not discard
 * them the way a real user turn does.
 */
export function acpIsAppOwnedWakeTurn(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "server";
}

export function acpIsProviderContinuationMessage(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "provider";
}

export function acpCarryoverTerminalShouldClearContinuation(input: {
  readonly continuationOffered: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.continuationOffered && input.wakeBufferLength === 0;
}

export function acpTurnStartShouldPreserveContinuation(input: {
  readonly continuationRequested: boolean;
  readonly isContinuationTurn: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.isContinuationTurn && input.continuationRequested && input.wakeBufferLength > 0;
}

export function acpPostSettleMonitorPromptShouldSuppress(
  mutation:
    | {
        readonly taskId: string;
        readonly status: "running" | "completed" | "failed";
      }
    | undefined,
): boolean {
  return mutation?.status === "running";
}

export function acpCompletedTurnShouldTerminalizeTool(
  tool: AcpToolCallState,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundTaskId" | "extractSubagentUpdate">,
): boolean {
  const status = toolStatus(tool.status);
  if (status !== "pending" && status !== "running") return false;
  if (flavor.extractBackgroundTaskId?.(tool) !== undefined) return false;
  return flavor.extractSubagentUpdate?.(tool) === undefined;
}

import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";

const at = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");

export function callTimelineEntry(
  toolName: string,
  input: unknown,
  output: unknown,
  status: OrchestrationV2TurnItem["status"] = "completed",
  id = "tool",
  senderThreadId = "thread-sender",
  runId: string | null = null,
) {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make(senderThreadId),
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input,
    output,
  };
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        item,
        position: 0,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      },
    ],
    optimisticMessages: [],
  });
  if (entry?.kind !== "work") throw new Error("expected a work entry");
  return entry;
}

export const callEntry = (...args: Parameters<typeof callTimelineEntry>) =>
  callTimelineEntry(...args).entry;

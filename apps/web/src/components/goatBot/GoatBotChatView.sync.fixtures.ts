import {
  MessageId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
const at = DateTime.makeUnsafe("2026-10-12T09:40:00Z");
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
export function completedTask(threadId: ThreadId, id: string, taskId: string, ordinal: number) {
  return decodeItem({
    ...turnItem(threadId, id, "assistant", "", ordinal),
    type: "notification",
    startedAt: "2026-10-12T09:40:00.000Z",
    completedAt: "2026-10-12T09:40:00.000Z",
    updatedAt: "2026-10-12T09:40:00.000Z",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Work updated",
    ledgerTask: {
      taskId,
      conversationId: "conv",
      taskVersion: 1,
      title: "Task",
      status: "completed",
      originKind: "goat",
      requesterLabel: "Person",
      createdAt: "2026-10-12T09:40:00.000Z",
      updatedAt: "2026-10-12T09:40:00.000Z",
      summary: "Outcome",
      openQuestionCount: 0,
    },
  });
}
export function taskOutcome(threadId: ThreadId, id: string, taskId: string, ordinal: number) {
  return decodeItem({
    ...turnItem(threadId, id, "assistant", `Outcome ${id}`, ordinal),
    startedAt: "2026-10-12T09:40:00.000Z",
    completedAt: "2026-10-12T09:40:00.000Z",
    updatedAt: "2026-10-12T09:40:00.000Z",
    channel: {
      conversationId: "conv",
      originKind: "goat",
      kind: "result",
      taskId,
      taskGeneration: 1,
    },
  });
}
export function turnItem(
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  text: string,
  ordinal: number,
): OrchestrationV2TurnItem {
  const common = {
    id: TurnItemId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    messageId: MessageId.make(`message-${id}`),
    text,
  };
  return role === "user"
    ? {
        ...common,
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      }
    : { ...common, type: "assistant_message", streaming: false };
}

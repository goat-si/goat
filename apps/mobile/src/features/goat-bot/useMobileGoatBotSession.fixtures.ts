import {
  OrchestrationV2TurnItemJson,
  RunId,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = "2026-10-28T12:00:00.000Z";
/** A GOAT Bot conversation: a request, the bot's acknowledgement and its task's card. */
export function conversation(worker: object): OrchestrationV2ProjectedTurnItem[] {
  const base = {
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const meta = { conversationId: "conv-1", originKind: "goat" };
  return [
    {
      ...base,
      id: "in",
      ordinal: 0,
      type: "user_message",
      messageId: "m-in",
      inputIntent: "turn_start",
      text: "Check the disks",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      channel: { ...meta, kind: "inbound", inputId: "in-1", readAt: at },
    },
    {
      ...base,
      id: "ack",
      ordinal: 1,
      type: "assistant_message",
      messageId: "m-ack",
      text: "Checking now.",
      streaming: false,
      channel: { ...meta, kind: "receipt", inReplyToInputId: "in-1", taskId: "task-1" },
    },
    {
      ...base,
      id: "card",
      ordinal: 2,
      type: "notification",
      source: { kind: "background_task" },
      outcome: "updated",
      summary: "Work updated",
      ledgerTask: {
        taskId: "task-1",
        conversationId: "conv-1",
        taskVersion: 1,
        title: "Check the disks",
        status: "running",
        originKind: "goat",
        requesterLabel: "Jun",
        createdAt: at,
        updatedAt: at,
        summary: "Copying files",
        worker,
        openQuestionCount: 0,
      },
    },
  ].map((json, position) => {
    const item = decodeItem(json);
    return {
      position,
      visibility: "local" as const,
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    };
  });
}
// A session run waiting on approval while its tool call runs; only the approval may show.
export const detail = (requestStatus: "pending" | "resolved") => ({
  environmentId: "env",
  projection: {
    runs: [{ id: "run-1", status: "running" }],
    nodes: [{ id: "node-1", runId: "run-1" }],
    runtimeRequests: [{ nodeId: "node-1", kind: "command", status: requestStatus }],
    turnItems: [
      {
        type: "command_execution",
        runId: RunId.make("run-1"),
        status: "running",
        title: "Run df -h",
        updatedAt: DateTime.makeUnsafe(at),
      },
    ],
  },
});

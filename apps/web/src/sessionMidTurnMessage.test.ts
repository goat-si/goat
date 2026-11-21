import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "./session-logic";

it("keeps the full Claude message in order after collapse and rejects an imitation", () => {
  const threadId = ThreadId.make("thread:mid-turn");
  const runId = RunId.make("run:mid-turn");
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
  const draft = "## Draft\n\n> The full reply.";
  const base = {
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const sent = {
    ...base,
    id: TurnItemId.make("turn-item:show"),
    ordinal: 1,
    type: "dynamic_tool" as const,
    toolName: "mcp__goat__goat_call",
    input: { path: "message.show" },
    output: { sentMessage: draft },
  };
  const items: OrchestrationV2TurnItem[] = [
    sent,
    { ...sent, id: TurnItemId.make("turn-item:fake"), ordinal: 2, input: { path: "thread.read" } },
    {
      ...base,
      id: TurnItemId.make("turn-item:reply"),
      ordinal: 3,
      type: "assistant_message",
      messageId: MessageId.make("message:reply"),
      text: "Final reply.",
      streaming: false,
    },
  ];
  const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position) => ({
      sourceThreadId: threadId,
      sourceItemId: item.id,
      visibility: "local",
      position,
      item,
    })),
    optimisticMessages: [],
  });
  expect(timelineEntries.map((entry) => entry.kind)).toEqual(["sent-message", "work", "message"]);
  const rows = deriveMessagesTimelineRows({
    timelineEntries,
    latestRun: {
      runId,
      status: "completed",
      startedAt: DateTime.formatIso(now),
      completedAt: DateTime.formatIso(now),
    },
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  expect(rows.filter((row) => row.kind === "sent-message" || row.kind === "message")).toMatchObject(
    [
      { kind: "sent-message", id: sent.id, text: draft },
      { kind: "message", message: { text: "Final reply." } },
    ],
  );
});

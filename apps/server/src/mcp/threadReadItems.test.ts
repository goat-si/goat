import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { timelineItemsWithinBudget } from "./threadReadItems.ts";

it("attributes automatic compaction to the system while preserving user messages", () => {
  const threadId = ThreadId.make("thread:test");
  const ids = [MessageId.make("message:compact"), MessageId.make("message:user")];
  const messages = [
    {
      id: ids[0],
      role: "user",
      text: "/compact",
      createdBy: "user",
      creationSource: "web",
      idleCompaction: "onReturn",
    },
    { id: ids[1], role: "user", text: "hello", createdBy: "user", creationSource: "web" },
  ] as unknown as OrchestrationV2ThreadProjection["messages"];
  const inputs = ids.map((messageId, index) => ({
    row: {
      position: index,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: TurnItemId.make(`item:${index}`),
      item: {
        type: "user_message",
        runId: RunId.make(`run:${index}`),
        messageId,
        status: "completed",
        title: null,
        text: index === 0 ? "/compact" : "hello",
        attachments: [],
        updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      },
    } as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"][number],
    maxChars: 1000,
    messagesByThreadId: new Map([[threadId, messages]]),
    tasksByThreadId: new Map(),
  }));
  expect(timelineItemsWithinBudget({}, inputs, false).items.map((item) => item.createdBy)).toEqual([
    "system",
    "user",
  ]);
});

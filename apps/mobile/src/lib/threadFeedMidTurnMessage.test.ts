import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation } from "./threadActivity";

it("shows a valid Claude Markdown message before the final reply when a run folds", () => {
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
    { ...sent, id: TurnItemId.make("turn-item:failed"), ordinal: 2, status: "failed" },
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
  const entries = buildThreadFeed(
    items.map((item, position) => ({
      sourceThreadId: threadId,
      sourceItemId: item.id,
      visibility: "local",
      position,
      item,
    })),
  );
  expect(entries.map((entry) => entry.type)).toEqual(["sent-message", "activity-group", "message"]);
  const rows = deriveThreadFeedPresentation(entries, null, new Set());
  expect(rows.filter((row) => row.type === "sent-message" || row.type === "message")).toMatchObject(
    [
      { type: "sent-message", text: draft },
      { type: "message", message: { text: "Final reply." } },
    ],
  );
});

import {
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { deriveTimelineEntriesFromVisibleTurnItems } from "./session-logic";
import { makeThreadProjectionFixture } from "./test-fixtures";

it("waits for a dispatched turn item before adding queued input to the timeline", () => {
  const projection = makeThreadProjectionFixture();
  const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
  const runId = RunId.make("run-dispatched-queued");
  const messageId = MessageId.make("message-dispatched-queued");
  const optimisticMessage = {
    id: messageId,
    role: "user" as const,
    text: "Queued input",
    runId: null,
    inputIntent: "queued_turn" as const,
    streaming: false,
    createdAt: DateTime.formatIso(now),
    updatedAt: DateTime.formatIso(now),
  };

  expect(
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [],
      optimisticMessages: [optimisticMessage],
    }),
  ).toEqual([]);

  const dispatchedItem = {
    id: TurnItemId.make("item-dispatched-queued"),
    threadId: projection.thread.id,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 200,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message" as const,
    messageId,
    inputIntent: "turn_start" as const,
    text: "Queued input",
    attachments: [],
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    scheduledTaskId: ScheduledTaskId.make("task-queued"),
    senderThreadId: ThreadId.make("thread-agent-sender"),
  } satisfies OrchestrationV2TurnItem;
  for (const inputIntent of [
    "queued_turn",
    "turn_start",
    "steer",
    "promoted_queued_to_steer",
  ] as const) {
    expect(
      deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [
          {
            position: 0,
            visibility: "local",
            sourceThreadId: projection.thread.id,
            sourceItemId: dispatchedItem.id,
            item: { ...dispatchedItem, inputIntent, status: "pending" },
          },
        ],
        optimisticMessages: [],
      }),
    ).toHaveLength(inputIntent === "queued_turn" ? 0 : 1);
  }
  const promotedEntries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: projection.thread.id,
        sourceItemId: dispatchedItem.id,
        item: dispatchedItem,
      },
    ],
    optimisticMessages: [optimisticMessage],
  });
  expect(promotedEntries.map((entry) => entry.id)).toEqual([messageId]);
  expect(promotedEntries[0]?.kind).toBe("message");
  if (promotedEntries[0]?.kind === "message") {
    expect(promotedEntries[0].message.inputIntent).toBe("turn_start");
    expect(promotedEntries[0].message.scheduledTaskId).toBe("task-queued");
    expect(promotedEntries[0].message.senderThreadId).toBe("thread-agent-sender");
  }
});

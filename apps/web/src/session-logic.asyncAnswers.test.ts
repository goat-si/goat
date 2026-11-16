import {
  MessageId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntry,
} from "./session-logic";

describe("async answers in the v2 timeline", () => {
  const timestamp = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
  const base = {
    id: TurnItemId.make("native-item"),
    threadId: ThreadId.make("native-thread"),
    runId: RunId.make("native-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });

  it("shows a late async answer that started a later run where that run begins", () => {
    const requestId = RuntimeRequestId.make("late-question");
    const inRun = (item: OrchestrationV2TurnItem, runId: string, ordinal: number) =>
      visible({ ...item, runId: RunId.make(runId), ordinal });
    const userMessage = (
      id: string,
      text: string,
    ): Extract<OrchestrationV2TurnItem, { type: "user_message" }> => ({
      ...base,
      id: TurnItemId.make(id),
      type: "user_message",
      messageId: MessageId.make(id),
      inputIntent: "queued_turn",
      text,
      createdBy: "user",
      creationSource: "web",
      attachments: [],
    });
    const assistantMessage = (id: string, text: string): OrchestrationV2TurnItem => ({
      ...base,
      id: TurnItemId.make(id),
      type: "assistant_message",
      messageId: MessageId.make(id),
      text,
      streaming: false,
    });
    const question = inRun(
      {
        ...base,
        id: TurnItemId.make("late-question"),
        type: "user_input_request",
        requestId,
        questions: [],
        questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
      },
      "run-8",
      8_000_070,
    );
    const answerMessageId = MessageId.make(`async-answer:${requestId}`);
    const settledPrefix = [
      question,
      inRun(userMessage("queued", "Queued follow-up"), "run-9", 9_000_001),
      inRun(assistantMessage("reply-9", "RUN 9 REPLY"), "run-9", 9_000_002),
    ];
    const lateRun = [
      inRun(
        {
          ...userMessage(answerMessageId, "Which color?\nBlue"),
          inputIntent: "steer",
          creationSource: "server",
        },
        "run-10",
        10_000_001,
      ),
      inRun(assistantMessage("reply-10", "RUN 10 ACKNOWLEDGED BLUE"), "run-10", 10_000_002),
    ];
    const input = { visibleTurnItems: [...settledPrefix, ...lateRun], optimisticMessages: [] };
    const messageIds = (entries: ReadonlyArray<TimelineEntry>) =>
      entries.flatMap((entry) => (entry.kind === "message" ? [entry.message.id] : []));
    const expectedMessageIds = ["queued", "reply-9", answerMessageId, "reply-10"];

    expect
      .soft(messageIds(deriveTimelineEntriesFromVisibleTurnItems(input)), "full projection")
      .toEqual(expectedMessageIds);
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState({
      ...input,
      visibleTurnItems: settledPrefix,
    });
    expect
      .soft(
        messageIds(deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous).entries),
        "incremental projection",
      )
      .toEqual(expectedMessageIds);
  });
});

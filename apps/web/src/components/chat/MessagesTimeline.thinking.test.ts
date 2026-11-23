import { expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

it("does not show Thinking once the provider turn has ended or its reply is streaming", () => {
  const input = {
    timelineEntries: [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user" as never,
          role: "user" as const,
          text: "Take over the queue",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
    ],
    latestRun: {
      runId: "turn-1" as never,
      status: "running" as const,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
    },
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  };

  expect(deriveMessagesTimelineRows(input).at(-1)?.kind).toBe("thinking");
  const ended = deriveMessagesTimelineRows({
    ...input,
    latestRun: { ...input.latestRun, turnEnded: true },
  });
  expect(ended.some((row) => row.kind === "thinking")).toBe(false);

  const streamingReply = deriveMessagesTimelineRows({
    ...input,
    timelineEntries: [
      ...input.timelineEntries,
      {
        id: "assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant" as never,
          role: "assistant" as const,
          text: "Here is the first paragraph of the answer",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: true,
        },
      },
    ],
  });
  expect(streamingReply.at(-1)?.id).toBe("assistant-entry");
  expect(streamingReply.some((row) => row.kind === "thinking")).toBe(false);
});

import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("deriveMessagesTimelineRows once the provider turn ends", () => {
  it("does not show Thinking once the open run's provider turn has ended", () => {
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
  });

  it("turns the Working header into Worked for once the open run's provider turn has ended, with the live row", () => {
    const message = (id: string, role: "user" | "assistant", at: string) => ({
      id: `${id}-entry`,
      kind: "message" as const,
      createdAt: at,
      message: {
        id: id as never,
        role,
        text: role === "user" ? "Fix the build" : "Fixed.",
        runId: "turn-1" as never,
        createdAt: at,
        updatedAt: at,
        streaming: false,
      },
    });
    const input = {
      timelineEntries: [
        message("user", "user", "2026-01-01T00:00:00Z"),
        {
          id: "work-entry",
          kind: "work" as const,
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        message("assistant", "assistant", "2026-01-01T00:00:12Z"),
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      runningRunId: "turn-1" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const running = deriveMessagesTimelineRows(input);
    expect(running.map((row) => row.id)).toContain("working-indicator-row");
    expect(running.some((row) => row.kind === "turn-fold")).toBe(false);

    const ended = deriveMessagesTimelineRows({
      ...input,
      latestRun: { ...input.latestRun, turnEnded: true },
    });
    expect(ended.map((row) => row.id)).not.toContain("working-indicator-row");
    expect(ended.find((row) => row.kind === "turn-fold")).toMatchObject({
      runId: "turn-1",
      label: "Worked for 12s",
    });
  });
});

import { MessageId, RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { liveAnswerPreview } from "./MessagesTimeline.toolCallVisibility";

// Upstream 3d78e915e3's case, in its own file because MessagesTimeline.logic.test.ts is at its entry.
describe("tool-call visibility", () => {
  it("hides tool calls or everything but the final answer", () => {
    const runId = RunId.make("turn-1");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      inputIntent?: "steer",
    ): TimelineEntry => ({
      id,
      kind: "message",
      createdAt: at(second),
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId: role === "user" ? null : runId,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
        ...(inputIntent ? { inputIntent } : {}),
      },
    });
    const command = (
      id: string,
      status: "completed" | "failed",
      second: number,
    ): TimelineEntry => ({
      id,
      kind: "work",
      createdAt: at(second),
      entry: {
        id,
        createdAt: at(second),
        runId,
        label: "Ran command",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: status,
      },
    });
    const [user, step, passed, failed, final] = [
      message("user", "user", 0),
      message("step", "assistant", 5),
      command("passed", "completed", 8),
      command("failed", "failed", 9),
      message("final", "assistant", 20),
    ];
    const running = { runId, status: "running" as const, startedAt: at(0), completedAt: null };
    const ended = { ...running, turnEnded: true };
    const rows = (
      timelineEntries: ReadonlyArray<TimelineEntry>,
      toolCallVisibility: "hideSuccessful" | "hideAll" | "zen",
      latestRun?: typeof ended | typeof running,
    ) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        expandedRunIds: new Set([runId]),
        isWorking: latestRun !== undefined,
        ...(latestRun ? { latestRun } : {}),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        toolCallVisibility,
      }).map((row) => row.id);

    const turn = [user, step, passed, failed, final];
    // Show all, the default and the way back, hides nothing.
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: turn,
        expandedRunIds: new Set([runId]),
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        toolCallVisibility: "showAll",
      }).map((row) => row.id),
    ).toEqual(
      deriveMessagesTimelineRows({
        timelineEntries: turn,
        expandedRunIds: new Set([runId]),
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).map((row) => row.id),
    );
    expect(rows(turn, "hideSuccessful")).toEqual([
      "user",
      "turn-fold:turn-1",
      "step",
      "failed",
      "final",
    ]);
    expect(rows([user, failed, final], "hideAll")).toEqual(["user", "final"]);
    expect(rows(turn, "zen")).toEqual(["user", "final"]);
    const [steer, answer] = [
      message("steer", "user", 4, "steer"),
      message("answer", "assistant", 7),
    ];
    expect(rows([user, steer, answer, final], "zen")).toEqual(["user", "steer", "answer", "final"]);
    expect(rows([user, steer, step, passed, final], "zen")).toEqual(["user", "steer", "final"]);
    expect(rows([user, steer, answer, step], "zen", running)).toEqual([
      "user",
      "working-indicator-row",
      "steer",
      "answer",
      "live-activity-row",
    ]);
    expect(rows([user, step, passed], "zen", running)).toEqual([
      "user",
      "working-indicator-row",
      "live-activity-row",
    ]);
    expect(liveAnswerPreview([user, step, passed])).toBe("step");
    expect(rows(turn, "zen", ended)).toEqual(["user", "final"]);
    const followUp = message("follow-up", "user", 30);
    // GOAT shows no Working row once the provider turn has ended (timelineLiveRun.ts), until the
    // server opens the follow-up's run; upstream shows one here.
    expect(rows([...turn, followUp], "zen", ended)).toEqual(["user", "final", "follow-up"]);
    const wake: TimelineEntry = {
      id: "wake",
      kind: "work",
      createdAt: at(30),
      entry: {
        id: "wake",
        createdAt: at(30),
        runId: RunId.make("wake"),
        label: "Task finished",
        tone: "info",
        itemType: "notification",
      },
    };
    expect(rows([user, final, wake], "zen", { ...running, runId: RunId.make("wake") })).toEqual([
      "user",
      "final",
      "wake",
      "working-indicator-row",
      "live-activity-row",
    ]);
  });
});

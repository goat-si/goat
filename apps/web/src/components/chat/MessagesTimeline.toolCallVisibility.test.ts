import {
  MessageId,
  PlanId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  entriesShownForToolCallVisibility,
  liveAnswerPreview,
} from "./MessagesTimeline.toolCallVisibility";

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

  it("never hides what needs the person: approvals, questions, errors, plans and their messages", () => {
    const threadId = ThreadId.make("thread-1");
    const runId = RunId.make("turn-1");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const base = (id: string, second: number, status: OrchestrationV2TurnItem["status"]) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: second,
      status,
      title: null,
      startedAt: DateTime.makeUnsafe(at(second)),
      completedAt:
        status === "completed" || status === "failed" ? DateTime.makeUnsafe(at(second)) : null,
      updatedAt: DateTime.makeUnsafe(at(second)),
    });
    const failure = {
      class: "provider_error" as const,
      message: "API overloaded.",
      code: null,
      retryable: false,
    };
    const requestId = RuntimeRequestId.make("question");
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base("user", 0, "completed"),
        type: "user_message",
        messageId: MessageId.make("user"),
        text: "Ship it",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      },
      { ...base("passed", 1, "completed"), type: "command_execution", input: "pwd", output: "" },
      {
        ...base("approval", 2, "pending"),
        type: "approval_request",
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        prompt: "Allow rm?",
      },
      {
        ...base("answered", 3, "completed"),
        type: "user_input_request",
        requestId,
        questions: [],
        questionAnswer: {
          requestId,
          questionTextById: { scope: "Which scope?" },
          answers: { scope: "All" },
          attachmentsByQuestionId: {},
        },
      },
      {
        ...base("asking", 3, "pending"),
        type: "user_input_request",
        requestId: RuntimeRequestId.make("asking"),
        questions: [],
      },
      { ...base("error", 4, "failed"), type: "error", failure },
      { ...base("runtime-error", 5, "completed"), type: "error", failure },
      {
        ...base("plan", 6, "completed"),
        type: "proposed_plan",
        planId: PlanId.make("plan"),
        markdown: "# Plan",
        streaming: false,
      },
      {
        ...base("final", 7, "completed"),
        type: "assistant_message",
        messageId: MessageId.make("final"),
        text: "Done",
        streaming: false,
      },
    ];
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      })),
      optimisticMessages: [],
    });
    const kept = (entry: TimelineEntry) =>
      entry.kind === "message"
        ? entry.message.id
        : entry.kind === "work"
          ? entry.entry.id
          : entry.kind;
    const allIds = entries.map(kept);
    for (const toolCallVisibility of ["hideSuccessful", "hideAll", "zen"] as const) {
      const shown = entriesShownForToolCallVisibility(
        { timelineEntries: entries, toolCallVisibility },
        false,
        () => new Set(),
      ).map(kept);
      expect(shown, toolCallVisibility).toEqual(
        allIds.filter(
          (id) =>
            !String(id).includes("passed") &&
            // Zen leaves the open question to ComposerPendingUserInputPanel above the composer.
            !(toolCallVisibility === "zen" && String(id).includes("asking")),
        ),
      );
    }

    const running = { runId, status: "running" as const, startedAt: at(0), completedAt: null };
    const live = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        items[0]!,
        {
          ...base("live", 8, "running"),
          type: "command_execution",
          input: "vp test",
          output: "",
        } satisfies OrchestrationV2TurnItem,
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      })),
      optimisticMessages: [],
    });
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: live,
        expandedRunIds: new Set([runId]),
        isWorking: true,
        latestRun: running,
        runningRunId: runId,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        toolCallVisibility: "hideAll",
      }).map((row) => row.id),
    ).toContain("working-indicator-row");
  });
});

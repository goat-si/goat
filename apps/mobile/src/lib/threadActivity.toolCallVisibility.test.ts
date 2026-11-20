import {
  MessageId,
  PlanId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  type ThreadFeedLatestRun,
} from "./threadActivity";

// Upstream 3d78e915e3's case. threadActivity.test.ts is at its entry, so it lives here with copies
// of that file's fixtures (threadId, sourceThreadId, runId, base, projected, userMessage, command,
// assistantMessage), byte for byte.
const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("tool-call visibility", () => {
  it("hides tool calls or everything but the final answer", () => {
    const at = (second: number) => `2026-06-20T00:00:${String(second).padStart(2, "0")}.000Z`;
    const say = (name: string, second: number, user = false, steer = false) => ({
      ...(user ? userMessage(at(second)) : assistantMessage(at(second))),
      id: TurnItemId.make(name),
      messageId: MessageId.make(name),
      text: name,
      ...(steer ? { inputIntent: "steer" as const } : {}),
    });
    const ran = (name: string, second: number, status: "completed" | "failed") => ({
      ...command(at(second)),
      id: TurnItemId.make(name),
      status,
    });
    const [user, step, passed, failed, final] = [
      say("user", 1, true),
      say("step", 2),
      ran("passed", 3, "completed"),
      ran("failed", 4, "failed"),
      say("final", 5),
    ];
    const running = { runId, status: "running" as const, startedAt: at(1), completedAt: null };
    const rows = (
      items: ReadonlyArray<OrchestrationV2TurnItem>,
      toolCallVisibility: "hideSuccessful" | "hideAll" | "zen",
      latestRun: ThreadFeedLatestRun | null = null,
    ) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(items.map((item, index) => projected(item, index))),
        latestRun,
        new Set([runId]),
        new Set(),
        latestRun ? at(1) : null,
        false,
        undefined,
        { toolCallVisibility, revealedMessageId: null },
      ).map((row) =>
        row.type === "activity-group"
          ? row.activities.map((activity) => activity.projectedItem.item.id).join("+")
          : row.type === "thinking"
            ? `thinking:${row.providerStartingLabel ?? ""}`
            : row.type === "run-fold"
              ? "fold"
              : row.id,
      );

    const turn = [user, step, passed, failed, final];
    expect(rows(turn, "hideSuccessful")).toEqual(["user", "fold", "step", "failed", "final"]);
    expect(rows(turn, "hideAll")).toEqual(["user", "fold", "step", "final"]);
    expect(rows(turn, "zen")).toEqual(["user", "final"]);
    const [steer, answer] = [say("steer", 2, true, true), say("answer", 3)];
    expect(rows([user, steer, answer, final], "zen")).toEqual(["user", "steer", "answer", "final"]);
    // Upstream 836b86a5d6's lines for message phases.
    const commentary = { ...step, phase: "commentary" as const };
    expect(rows([user, commentary, steer, final], "zen")).toEqual(["user", "steer", "final"]);
    for (const phase of ["commentary", "partial_answer", "final_answer", undefined] as const) {
      const partial = { ...answer, ...(phase === undefined ? {} : { phase }) };
      const interrupted = buildThreadFeed(
        [user, passed, partial, steer, final].map((item, index) => projected(item, index)),
      );
      expect(
        deriveThreadFeedPresentation(interrupted, null, new Set()).some(
          (row) => row.type === "message" && row.message.id === answer.messageId,
        ),
      ).toBe(phase === "final_answer");
      expect(rows([user, partial, steer, final], "zen").includes("answer")).toBe(
        phase === "final_answer",
      );
    }
    // Upstream a044f0c0b3's lines.
    const confirmed = { ...answer, phase: "final_answer" as const };
    const continued = buildThreadFeed(
      [user, confirmed, passed, final].map((item, index) => projected(item, index)),
    );
    expect(
      deriveThreadFeedPresentation(continued, null, new Set()).some(
        (row) => row.type === "message" && row.message.id === answer.messageId,
      ),
    ).toBe(true);
    expect(rows([user, confirmed, passed, final], "zen")).toEqual(["user", "answer", "final"]);
    expect(rows([user, steer, step, passed, final], "zen")).toEqual(["user", "steer", "final"]);
    expect(rows([user, steer, answer, step], "zen", running)).toEqual([
      "user",
      "steer",
      "answer",
      "thinking:step",
    ]);
    expect(rows([user, step, passed], "zen", running)).toEqual(["user", "thinking:step"]);
    expect(rows(turn, "zen", { ...running, turnEnded: true })).toEqual(["user", "final"]);
    const nextRun = { ...running, runId: RunId.make("run-2") };
    const followUp = { ...say("follow-up", 6, true), runId: nextRun.runId };
    expect(rows([...turn, followUp], "zen", nextRun)).toEqual([
      "user",
      "final",
      "follow-up",
      "thinking:",
    ]);
    const wake: OrchestrationV2TurnItem = {
      ...base("wake", at(6), 5),
      runId: nextRun.runId,
      type: "notification",
      source: { kind: "background_task" },
      outcome: "completed",
      summary: "Task finished",
    };
    expect(rows([user, final, wake], "zen", nextRun)).toEqual([
      "user",
      "final",
      "wake",
      "thinking:",
    ]);
  });

  it("never hides what needs the person: approvals, questions, errors, plans and their messages", () => {
    const failure = {
      class: "provider_error" as const,
      message: "API overloaded.",
      code: null,
      retryable: false,
    };
    const requestId = RuntimeRequestId.make("question");
    const items: OrchestrationV2TurnItem[] = [
      userMessage(),
      { ...command(), id: TurnItemId.make("passed") },
      {
        ...base("approval", "2026-06-20T00:00:02.000Z", 2),
        status: "pending",
        completedAt: null,
        type: "approval_request",
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        prompt: "Allow rm?",
      },
      {
        ...base("answered", "2026-06-20T00:00:03.000Z", 3),
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
        ...base("asking", "2026-06-20T00:00:03.000Z", 3),
        status: "pending",
        completedAt: null,
        type: "user_input_request",
        requestId: RuntimeRequestId.make("asking"),
        questions: [],
      },
      { ...base("error", "2026-06-20T00:00:04.000Z", 4), status: "failed", type: "error", failure },
      { ...base("settled-error", "2026-06-20T00:00:04.000Z", 4), type: "error", failure },
      {
        ...base("plan", "2026-06-20T00:00:05.000Z", 5),
        type: "proposed_plan",
        planId: PlanId.make("plan"),
        markdown: "# Plan",
        streaming: false,
      },
      assistantMessage("2026-06-20T00:00:06.000Z"),
    ];
    const shownIds = (display?: {
      toolCallVisibility: "showAll" | "hideSuccessful" | "hideAll" | "zen";
    }) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(items.map((item, index) => projected(item, index))),
        null,
        new Set([runId]),
        new Set(),
        null,
        false,
        undefined,
        display === undefined ? undefined : { ...display, revealedMessageId: null },
      ).flatMap((row) =>
        row.type === "activity-group"
          ? row.activities.map((activity) => String(activity.projectedItem.item.id))
          : row.type === "message"
            ? [String(row.message.id)]
            : [row.type],
      );
    const needed = [
      "message-user",
      "approval",
      "answered",
      "asking",
      "error",
      "settled-error",
      "plan",
      "message-assistant",
    ];
    expect(shownIds()).toEqual(expect.arrayContaining(needed));
    for (const toolCallVisibility of ["hideSuccessful", "hideAll", "zen"] as const) {
      const shown = shownIds({ toolCallVisibility });
      // As upstream's zen keep list: zen leaves the open approval to PendingApprovalCard and the
      // open question to PendingUserInputCard above the composer, and drops a settled error.
      const zenLeavesOut = new Set(["approval", "asking", "settled-error"]);
      const kept =
        toolCallVisibility === "zen" ? needed.filter((id) => !zenLeavesOut.has(id)) : needed;
      expect(shown, toolCallVisibility).toEqual(expect.arrayContaining(kept));
      if (toolCallVisibility === "zen") {
        for (const id of zenLeavesOut) expect(shown, id).not.toContain(id);
      }
      expect(shown, toolCallVisibility).not.toContain("passed");
    }

    const running = {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    };
    const live = { ...command(), status: "running" as const, completedAt: null };
    expect(
      deriveThreadFeedPresentation(
        buildThreadFeed([userMessage(), live].map((item, index) => projected(item, index))),
        running,
        new Set([runId]),
        new Set(),
        running.startedAt,
        false,
        undefined,
        { toolCallVisibility: "hideAll", revealedMessageId: null },
      ).map((row) => row.type),
    ).toContain("thinking");
  });
});

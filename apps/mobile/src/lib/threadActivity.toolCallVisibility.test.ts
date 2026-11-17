import {
  MessageId,
  RunId,
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
});

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

import { buildThreadFeed, deriveThreadFeedPresentation, messageFoldRunId } from "./threadActivity";

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

describe("buildThreadFeed run folds", () => {
  it("names the fold that hides a progress message, with or without a run", () => {
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "Needle found in the build config.",
    };
    const items = [userMessage(), command(), middle, assistantMessage()];
    for (const runless of [false, true]) {
      const feed = buildThreadFeed(
        items.map((item, position) =>
          projected(runless ? { ...item, runId: null } : item, position),
        ),
      );
      const ids = (expanded: ReadonlySet<RunId>) =>
        deriveThreadFeedPresentation(feed, null, expanded).map((entry) => entry.id);
      const foldRunId = messageFoldRunId(
        feed,
        "message-middle",
        deriveThreadFeedPresentation(feed, null, new Set()),
      );
      expect(foldRunId, String(runless)).toBe(runless ? "runless:message-user" : runId);
      expect(ids(new Set())).not.toContain("message-middle");
      expect(ids(new Set([foldRunId!]))).toContain("message-middle");
    }
    expect(
      messageFoldRunId(buildThreadFeed([projected(userMessage(), 0)]), "message-user", []),
    ).toBe(null);
  });

  it("splits a settled turn's work fold at a steer", () => {
    const steer = {
      ...userMessage("2026-06-20T00:00:04.000Z"),
      id: TurnItemId.make("item-steer"),
      messageId: MessageId.make("message-steer"),
      inputIntent: "steer" as const,
    };
    const after = { ...command("2026-06-20T00:00:06.000Z"), id: TurnItemId.make("item-after") };
    const progress = {
      ...assistantMessage("2026-06-20T00:00:07.000Z"),
      id: TurnItemId.make("item-progress"),
      messageId: MessageId.make("message-progress"),
    };
    const feed = buildThreadFeed(
      [
        userMessage(),
        command(),
        steer,
        after,
        progress,
        assistantMessage("2026-06-20T00:00:09.000Z"),
      ].map((item, position) => projected(item, position)),
    );

    expect(
      deriveThreadFeedPresentation(feed, null, new Set()).map((entry) =>
        entry.type === "message" ? entry.id : entry.type,
      ),
    ).toEqual(["message-user", "run-fold", "message-steer", "run-fold", "message-assistant"]);
    const foldRunId = messageFoldRunId(
      feed,
      "message-progress",
      deriveThreadFeedPresentation(feed, null, new Set()),
    );
    expect(
      deriveThreadFeedPresentation(feed, null, new Set([foldRunId!])).map((entry) =>
        entry.type === "message" ? entry.id : entry.type,
      ),
    ).toEqual([
      "message-user",
      "run-fold",
      "message-steer",
      "run-fold",
      "activity-group",
      "message-progress",
      "message-assistant",
    ]);
  });
});

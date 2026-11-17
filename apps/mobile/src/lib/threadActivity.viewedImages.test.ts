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

import { buildThreadFeed, deriveThreadFeedPresentation } from "./threadActivity";

const threadId = ThreadId.make("viewed-images-thread");
const runId = RunId.make("viewed-images-run");
const at = (second: number) => `2026-11-04T12:00:${String(second).padStart(2, "0")}.000Z`;

function base(id: string, second: number) {
  const timestamp = DateTime.makeUnsafe(at(second));
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
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
): OrchestrationV2ProjectedTurnItem {
  return { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item };
}

const read = (id: string, second: number, filePath: string): OrchestrationV2TurnItem => ({
  ...base(id, second),
  type: "dynamic_tool",
  toolName: "Read",
  // The Claude adapter tags reads of image files.
  ...(filePath.endsWith(".png") ? { viewedImagePath: filePath } : {}),
  input: { file_path: filePath },
});

function items(settled: boolean): OrchestrationV2ProjectedTurnItem[] {
  return [
    {
      ...base("prompt", 0),
      type: "user_message",
      messageId: MessageId.make("prompt"),
      text: "Show me the mockups",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mobile",
    },
    read("read-sidebar", 1, "/repo/docs/sidebar.png"),
    read("read-notes", 2, "/repo/docs/notes.md"),
    read("read-sidebar-again", 3, "/repo/docs/sidebar.png"),
    read("read-topbar", 4, "/repo/docs/topbar.png"),
    ...(settled
      ? [
          {
            ...base("answer", 5),
            type: "assistant_message" as const,
            messageId: MessageId.make("answer"),
            text: "Here are both layouts",
            streaming: false,
          },
        ]
      : []),
  ].map((item, position) => projected(item as OrchestrationV2TurnItem, position));
}

function viewedImages(settled: boolean, expandedRunIds: ReadonlySet<string> = new Set()) {
  const feed = deriveThreadFeedPresentation(
    buildThreadFeed(items(settled)),
    {
      runId,
      status: settled ? "completed" : "running",
      startedAt: at(0),
      completedAt: settled ? at(5) : null,
    },
    expandedRunIds as never,
    new Set(),
    settled ? null : at(0),
  );
  return feed.flatMap((entry, index) =>
    entry.type === "viewed-images" ? [{ after: feed[index - 1]?.type, paths: entry.paths }] : [],
  );
}

describe("images the agent viewed in the mobile feed", () => {
  const paths = ["/repo/docs/sidebar.png", "/repo/docs/topbar.png"];

  it("shows them under their tool group, once each, while the turn runs", () => {
    expect(viewedImages(false)).toEqual([{ after: "activity-group", paths }]);
  });

  it("keeps them inside a settled turn's fold until it is opened", () => {
    expect(viewedImages(true)).toEqual([]);
    expect(viewedImages(true, new Set([runId]))).toEqual([{ after: "activity-group", paths }]);
  });
});

import { MessageId, RunId, RuntimeRequestId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("deriveMessagesTimelineRows viewed images", () => {
  it("shows images the agent viewed outside their collapsed tool group", () => {
    const threadId = ThreadId.make("viewed-images-thread");
    const runId = RunId.make("viewed-images-run");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 4, 12, 0, second)).toISOString());
    const base = (id: string, ordinal: number) => ({
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
      startedAt: at(ordinal),
      completedAt: at(ordinal),
      updatedAt: at(ordinal),
    });
    const read = (id: string, ordinal: number, filePath: string) => ({
      ...base(id, ordinal),
      type: "dynamic_tool" as const,
      toolName: "Read",
      // The Claude adapter tags reads of image files.
      ...(filePath.endsWith(".png") ? { viewedImagePath: filePath } : {}),
      input: { file_path: filePath },
    });
    const items = (settled: boolean) =>
      [
        {
          ...base("prompt", 0),
          type: "user_message" as const,
          messageId: MessageId.make("prompt"),
          text: "Show me the mockups",
          attachments: [],
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        },
        read("read-sidebar", 1, "/repo/docs/sidebar.png"),
        read("read-notes", 2, "/repo/docs/notes.md"),
        read("read-sidebar-again", 3, "/repo/docs/sidebar.png"),
        read("read-topbar", 4, "/repo/docs/topbar.png"),
        settled
          ? {
              ...base("answer", 5),
              type: "assistant_message" as const,
              messageId: MessageId.make("answer"),
              text: "Here are both layouts",
              streaming: false,
            }
          : {
              ...base("ask-again", 5),
              status: "waiting" as const,
              completedAt: null,
              type: "user_input_request" as const,
              requestId: RuntimeRequestId.make("layout-question"),
              questions: [],
            },
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const viewedImages = (settled: boolean, expandedRunIds?: ReadonlySet<RunId>) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(settled),
          optimisticMessages: [],
        }),
        latestRun: {
          runId,
          status: settled ? "completed" : "running",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: settled ? DateTime.formatIso(at(5)) : null,
        },
        runningRunId: settled ? null : runId,
        isWorking: !settled,
        activeTurnStartedAt: settled ? null : DateTime.formatIso(at(0)),
        ...(expandedRunIds === undefined ? {} : { expandedRunIds }),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      return rows.flatMap((row, index) =>
        row.kind === "viewed-images" ? [{ after: rows[index - 1]?.kind, paths: row.paths }] : [],
      );
    };
    const paths = ["/repo/docs/sidebar.png", "/repo/docs/topbar.png"];

    expect(viewedImages(false)).toEqual([{ after: "work-live", paths }]);
    // A settled turn's fold keeps hiding its work, images included, until it is opened.
    expect(viewedImages(true)).toEqual([]);
    expect(viewedImages(true, new Set([runId]))).toEqual([{ after: "work-toggle", paths }]);
  });
});

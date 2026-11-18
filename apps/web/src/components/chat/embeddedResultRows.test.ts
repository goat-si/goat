import { MessageId, RunId, ThreadId, TurnItemId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("empty embedded result replies", () => {
  it.each([
    ["html-render", "reply-run", true],
    ["mcp-app", "reply-run", true],
    ["html-render", "other-run", false],
    ["html-render", null, false],
    [null, null, false],
  ] as const)("suppresses the empty fallback for %s in %s: %s", (kind, renderRun, expected) => {
    const at = "2026-11-06T00:00:00Z";
    const runId = RunId.make("reply-run");
    const renderBase = {
      id: "render",
      createdAt: at,
      runId: renderRun ? RunId.make(renderRun) : null,
    };
    const embedded: TimelineEntry[] =
      kind === "html-render"
        ? [
            {
              ...renderBase,
              kind,
              htmlRender: { attachmentId: "preview", title: "Preview", height: 420 },
            },
          ]
        : kind === "mcp-app"
          ? [
              {
                ...renderBase,
                kind,
                sourceThreadId: ThreadId.make("thread"),
                itemId: TurnItemId.make("app"),
                revision: "1",
                mcpApp: {
                  attachmentId: "app",
                  server: "weather",
                  tool: "weather",
                  resourceUri: "ui://weather",
                },
              },
            ]
          : [];
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        ...embedded,
        {
          kind: "message",
          id: "reply",
          createdAt: at,
          message: {
            id: MessageId.make("reply"),
            role: "assistant",
            runId,
            text: "",
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
      latestRun: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const reply = rows.find((row) => row.kind === "message" && row.id === "reply");
    expect(reply).toMatchObject({ suppressEmptyResponse: expected });
  });
});

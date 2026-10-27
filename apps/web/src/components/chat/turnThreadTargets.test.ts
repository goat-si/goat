import { MessageId, RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { callTimelineEntry } from "./goatThreadCalls.fixtures";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const runId = RunId.make("cards-run");
const common = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false };

describe("turn thread cards", () => {
  it("collects the threads a turn launched or messaged into one card row after its answer", () => {
    const call = (tool: string, input: unknown, output: unknown, id: string) =>
      callTimelineEntry(tool, input, output, "completed", id, "thread-sender", runId);
    const final = {
      kind: "message" as const,
      id: "final",
      createdAt: "2026-09-08T10:00:04Z",
      message: {
        id: MessageId.make("final"),
        role: "assistant" as const,
        text: "Lanes are running",
        runId,
        streaming: false,
        createdAt: "2026-09-08T10:00:04Z",
        updatedAt: "2026-09-08T10:00:04Z",
      },
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        call("goat_thread_launch", { title: "Lane 1" }, { threadId: "lane-1" }, "launch"),
        call(
          "goat_thread_send",
          { threadId: "lane-1" },
          { threadId: "lane-1", messageId: "m" },
          "send-1",
        ),
        call(
          "goat_thread_send",
          { threadId: "lane-2" },
          { threadId: "lane-2", messageId: "n" },
          "send-2",
        ),
        call(
          "goat_ssh_thread_launch",
          { host: "mini" },
          { host: "mini", threadId: "lane-r" },
          "ssh",
        ),
        final,
      ],
      expandedRunIds: new Set([runId]),
    });
    expect(rows.find((row) => row.kind === "thread-cards")).toMatchObject({
      id: "thread-cards:final",
      targets: [
        { threadId: "lane-1", title: "Lane 1", via: "launch", host: null },
        { threadId: "lane-2", title: null, via: "send", host: null },
        { threadId: "lane-r", via: "launch", host: "mini" },
      ],
    });
  });
});

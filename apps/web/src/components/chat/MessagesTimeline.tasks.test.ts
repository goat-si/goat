import { MessageId, RunId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

it.each(["alone", "before tool", "before commentary and tool"])(
  "keeps an unfinished task update static %s",
  (placement) => {
    const runId = RunId.make("task-update-run");
    const at = "2026-11-06T00:00:00Z";
    const tasks: TimelineEntry = {
      kind: "work",
      id: "tasks",
      createdAt: at,
      entry: {
        id: "tasks",
        runId,
        createdAt: at,
        itemType: "todo_list",
        tone: "info",
        label: "Tasks 0/1 · Inspect the captures",
        toolLifecycleStatus: "inProgress",
      },
    };
    const commentary: TimelineEntry = {
      kind: "message",
      id: "commentary",
      createdAt: at,
      message: {
        id: MessageId.make("commentary"),
        role: "assistant",
        text: "Checking the rendering.",
        runId,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    };
    const tool: TimelineEntry = {
      kind: "work",
      id: "tool",
      createdAt: at,
      entry: {
        id: "tool",
        runId,
        createdAt: at,
        label: "Running sed",
        command: "sed",
        tone: "tool",
        toolLifecycleStatus: "inProgress",
      },
    };
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        tasks,
        ...(placement === "before commentary and tool" ? [commentary] : []),
        ...(placement === "alone" ? [] : [tool]),
      ],
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: at,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.id === "tasks")).toMatchObject({
      kind: "work",
      groupedEntries: [tasks.entry],
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual(
      placement === "alone" ? [] : [expect.objectContaining({ entry: tool.entry })],
    );
  },
);

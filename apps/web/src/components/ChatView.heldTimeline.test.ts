import { MessageId, RunId } from "@goat/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../session-logic";
import {
  peekHeldThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  type HeldThreadTimeline,
} from "./ChatView.logic";
import { deriveMessagesTimelineRows } from "./chat/MessagesTimeline.logic";

afterEach(resetHeldThreadTimeline);

it.each([false, true])(
  "preserves running tool rows when returning to a remembered thread (runless=%s)",
  (runless) => {
    const startedAt = "2026-01-01T00:00:00Z";
    const runId = runless ? null : RunId.make("running-run");
    const entries: TimelineEntry[] = [
      {
        id: "prompt",
        kind: "message",
        createdAt: startedAt,
        message: {
          id: MessageId.make("prompt"),
          role: "user",
          text: "inspect files",
          runId,
          createdAt: startedAt,
          updatedAt: startedAt,
          streaming: false,
        },
      },
      {
        id: "tool",
        kind: "work",
        createdAt: startedAt,
        entry: {
          id: "tool",
          createdAt: startedAt,
          runId,
          label: "Reading files",
          tone: "tool",
          command: "cat file.ts",
          requestKind: "command",
          toolLifecycleStatus: "inProgress",
        },
      },
    ];
    const activity: NonNullable<HeldThreadTimeline<TimelineEntry[]>["activity"]> = {
      isWorking: true,
      runlessWorkActive: runless,
      activeTurnInProgress: true,
      isCompacting: false,
      awaitingUser: null,
      activeTurnStartedAt: startedAt,
      latestRun: runId ? { runId, status: "running", startedAt, completedAt: null } : null,
      runningRunId: runId,
      runs: [],
      turnDiffSummaries: [],
    };
    const liveRows = deriveMessagesTimelineRows({
      ...activity,
      timelineEntries: entries,
      supportsConversationRollback: false,
    });
    expect(liveRows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(liveRows.some((row) => row.kind === "work-live")).toBe(true);
    rememberReadyThreadTimeline({ threadKey: "env:thread-a", entries, activity });
    const uncached = resolveThreadSwitchTimeline({
      loading: true,
      activeThreadKey: "env:thread-b",
      nextEntries: [] as TimelineEntry[],
    });
    expect(uncached).toEqual({ entries: [], displayThreadKey: "env:thread-b" });
    const displayed = resolveThreadSwitchTimeline({
      loading: true,
      activeThreadKey: "env:thread-a",
      nextEntries: [] as TimelineEntry[],
    });
    expect(displayed.displayThreadKey).toBe("env:thread-a");
    const held = peekHeldThreadTimeline<TimelineEntry[]>()!;
    expect(held.activity).toBeDefined();
    const heldRows = deriveMessagesTimelineRows({
      ...held.activity!,
      timelineEntries: displayed.entries,
      supportsConversationRollback: false,
    });
    expect(heldRows).toEqual(liveRows);
    expect(heldRows.some((row) => row.kind === "turn-fold")).toBe(false);
    const settledRows = deriveMessagesTimelineRows({
      timelineEntries: displayed.entries,
      latestRun: null,
      runningRunId: null,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(settledRows.some((row) => row.kind === "turn-fold")).toBe(true);
  },
);

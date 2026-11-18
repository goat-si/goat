import { MessageId, NodeId, RunAttemptId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

// Upstream 836b86a5d6's version of the "a steer that supersedes an attempt" block, in its own file
// because MessagesTimeline.logic.test.ts is at its entry. GOAT's existing block there is unchanged.
describe("a steer that supersedes an attempt, with message phases", () => {
  const runId = RunId.make("run-steered");
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
  const supersededAttempt = {
    id: RunAttemptId.make("attempt-1"),
    runId,
    attemptOrdinal: 1,
    rootNodeId: NodeId.make("node-attempt-1"),
    status: "superseded" as const,
    completedAt: DateTime.makeUnsafe(at(10)),
  };
  const nextAttempt = {
    id: RunAttemptId.make("attempt-2"),
    runId,
    attemptOrdinal: 2,
    rootNodeId: NodeId.make("node-attempt-2"),
    status: "completed" as const,
    completedAt: DateTime.makeUnsafe(at(14)),
  };
  const assistantEntry = (
    id: string,
    attempt: typeof supersededAttempt | typeof nextAttempt,
    completedSecond: number,
    phase?: "commentary" | "partial_answer" | "final_answer",
  ): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: at(2),
    attempt,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: `${id} text`,
      runId,
      createdAt: at(2),
      updatedAt: at(completedSecond),
      streaming: false,
    },
    projectedItem: {
      item: {
        type: "assistant_message",
        ...(phase === undefined ? {} : { phase }),
        status: "completed",
        completedAt: DateTime.makeUnsafe(at(completedSecond)),
      },
    } as never,
  });
  const rowsFor = (
    replyCompletedSecond: number,
    runStatus: "running" | "completed" = "completed",
    toolCallVisibility: "showAll" | "zen" = "showAll",
    phase?: "commentary" | "partial_answer" | "final_answer",
    nativeSteer = false,
  ) =>
    deriveMessagesTimelineRows({
      toolCallVisibility,
      timelineEntries: (
        [
          {
            id: "initial-user-entry",
            kind: "message",
            createdAt: at(0),
            attempt: supersededAttempt,
            message: {
              id: MessageId.make("initial-user"),
              role: "user",
              text: "Build it",
              runId,
              inputIntent: "turn_start",
              createdAt: at(0),
              updatedAt: at(0),
              streaming: false,
            },
          },
          {
            id: "old-work-entry",
            kind: "work",
            createdAt: at(1),
            attempt: supersededAttempt,
            entry: { id: "old-work", createdAt: at(1), runId, label: "Read", tone: "tool" },
          },
          assistantEntry("status-entry", supersededAttempt, 1, "commentary"),
          assistantEntry("old-reply-entry", supersededAttempt, replyCompletedSecond, phase),
          {
            id: "steer-user-entry",
            kind: "message",
            createdAt: at(10),
            attempt: nextAttempt,
            message: {
              id: MessageId.make("steer-user"),
              role: "user",
              text: "What are you working on?",
              runId,
              inputIntent: "steer",
              createdAt: at(10),
              updatedAt: at(10),
              streaming: false,
            },
          },
          assistantEntry("new-reply-entry", nextAttempt, 14),
        ] satisfies ReadonlyArray<TimelineEntry>
      ).map((entry) => (nativeSteer ? { ...entry, attempt: nextAttempt } : entry)),
      latestRun: {
        runId,
        status: runStatus,
        startedAt: at(0),
        completedAt: runStatus === "completed" ? at(14) : null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it.each([
    ["final_answer", 4, true],
    ["final_answer", 11, true],
    ["commentary", 4, false],
    ["commentary", 11, false],
    ["partial_answer", 11, false],
    [undefined, 4, true],
    [undefined, 11, false],
  ] as const)(
    "retains phase %s ending at %s only when it is a final reply: %s",
    (phase, completedSecond, retained) => {
      for (const runStatus of ["running", "completed"] as const) {
        for (const visibility of ["showAll", "zen"] as const) {
          const rows = rowsFor(completedSecond, runStatus, visibility, phase);
          expect(rows.some((row) => row.id === "old-reply-entry")).toBe(retained);
          if (phase !== undefined && runStatus === "completed") {
            const nativeRows = rowsFor(completedSecond, runStatus, visibility, phase, true);
            expect(nativeRows.some((row) => row.id === "old-reply-entry")).toBe(retained);
            expect(nativeRows.some((row) => row.id === "status-entry")).toBe(false);
          }
          if (runStatus === "completed") {
            expect(rows.some((row) => row.id === "status-entry")).toBe(false);
          }
        }
      }
    },
  );
});

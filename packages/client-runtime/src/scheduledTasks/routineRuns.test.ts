import { expect, it } from "vite-plus/test";
import { ChannelInputId, CommandId, ThreadId, type ScheduledTaskRecentRun } from "@goat/contracts";
import { scheduledTaskRunPresentation } from "../scheduledTaskRun.ts";
import { botRoutineRuns } from "./routineRuns.ts";

const conversation = (input: string) => ({
  threadId: ThreadId.make("bot-thread"),
  inputId: ChannelInputId.make(input),
});
const run = (
  hour: number,
  status: string,
  extra: Partial<Pick<ScheduledTaskRecentRun, "conversation" | "quiet" | "dispatchFailed">> = {},
): ScheduledTaskRecentRun => ({
  firingId: CommandId.make(`firing-${hour}`),
  status,
  requestedAt: `2026-11-14T${String(hour).padStart(2, "0")}:00:00.000Z`,
  completedAt: null,
  ...extra,
});
const formatTime = (iso: string) => `Nov 14, ${iso.slice(11, 16)}`;

it("names each run's time and outcome in the last-run words, marks quiet runs, oldest first, at most the visible count", () => {
  const recentRuns = [
    run(9, "completed", { quiet: true, conversation: conversation("input-9") }),
    run(8, "failed", { conversation: conversation("input-8") }),
    run(7, "failed", { dispatchFailed: true }),
    // The bot took this run, but its conversation is unknown: it still only failed.
    run(6, "failed"),
    run(5, "running", { conversation: conversation("input-5") }),
    run(4, "paused_by_policy"),
    run(3, "completed", { conversation: conversation("input-3") }),
  ];
  const dots = botRoutineRuns({ recentRuns }, 6, formatTime);
  expect(dots.map((dot) => [dot.shape, dot.accessibleName, dot.conversation?.inputId])).toEqual([
    ["hollow-square", "Run on Nov 14, 04:00, outcome unavailable", undefined],
    ["hollow-diamond", "Run on Nov 14, 05:00, running", "input-5"],
    ["filled-square", "Run on Nov 14, 06:00, failed", undefined],
    ["filled-square", "Run on Nov 14, 07:00, dispatch failed", undefined],
    ["filled-square", "Run on Nov 14, 08:00, failed", "input-8"],
    ["bar", "Run on Nov 14, 09:00, no update", "input-9"],
  ]);
  // A failed run reads as the row's last-run line reads it, from the same dispatch outcome.
  const lastRunWord = (dispatchStatus: "accepted" | "failed") =>
    scheduledTaskRunPresentation({
      lastRunStatus: "failed",
      lastRun: {
        firingId: CommandId.make("firing"),
        dispatchStatus,
        status: "failed",
        threadId: null,
        runId: null,
        requestedAt: recentRuns[0]!.requestedAt,
        dispatchedAt: null,
        startedAt: null,
        completedAt: null,
      },
    }).label.toLowerCase();
  expect([dots[2]?.word, dots[3]?.word]).toEqual([lastRunWord("accepted"), lastRunWord("failed")]);
});

it("absent history draws no dots", () => {
  expect(botRoutineRuns({}, 7, formatTime)).toEqual([]);
  expect(botRoutineRuns({ recentRuns: [] }, 7, formatTime)).toEqual([]);
});

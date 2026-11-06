import type { ScheduledTask, ScheduledTaskId, ThreadId } from "@goat/contracts";
import { scheduledTaskRunPresentation } from "../scheduledTaskRun.ts";
import { formatTimeUntil, scheduleLabel } from "./scheduleLabel.ts";

export type BotRoutineSource = Pick<
  ScheduledTask,
  | "id"
  | "title"
  | "prompt"
  | "enabled"
  | "schedule"
  | "threadId"
  | "nextRunAt"
  | "lastRunAt"
  | "lastRunStatus"
  | "lastRunError"
> &
  Partial<Pick<ScheduledTask, "lastRun">>;

export interface BotRoutineRow {
  readonly id: ScheduledTaskId;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleText: string;
  readonly nextText: string;
  readonly lastText: string;
  readonly lastFailed: boolean;
}

/** Routines bound to a bot's conversation, active and soonest first. */
export function botRoutineRows(
  tasks: readonly BotRoutineSource[],
  botThreadId: ThreadId,
  nowMs: number,
): BotRoutineRow[] {
  return tasks
    .filter((task) => task.threadId === botThreadId)
    .toSorted(compareRoutines)
    .map((task) => {
      const run = scheduledTaskRunPresentation(task);
      return {
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        enabled: task.enabled,
        scheduleText: scheduleLabel(task.schedule),
        nextText: nextRunText(task, nowMs),
        lastText: lastRunText(task, run, nowMs),
        lastFailed: run.tone === "error",
      };
    });
}

function compareRoutines(a: BotRoutineSource, b: BotRoutineSource): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const aNext = a.nextRunAt === null ? Infinity : Date.parse(a.nextRunAt);
  const bNext = b.nextRunAt === null ? Infinity : Date.parse(b.nextRunAt);
  if (aNext !== bNext) return aNext < bNext ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function nextRunText(task: BotRoutineSource, nowMs: number): string {
  if (!task.enabled) return "Paused";
  if (task.schedule.type === "webhook") return "Listening";
  if (task.nextRunAt === null) return "Not scheduled";
  const diffMs = Date.parse(task.nextRunAt) - nowMs;
  return diffMs > 0 ? `Next run ${formatTimeUntil(diffMs)}` : "Next run due";
}

function lastRunText(
  task: BotRoutineSource,
  run: ReturnType<typeof scheduledTaskRunPresentation>,
  nowMs: number,
): string {
  if (task.lastRunAt === null && task.lastRunStatus === "never" && task.lastRun === undefined) {
    return "Not run yet";
  }
  const when = task.lastRunAt === null ? "" : ` ${timeAgo(Date.parse(task.lastRunAt), nowMs)}`;
  const error = run.error?.split("\n")[0]?.trim();
  return `Last run${when} · ${run.label.toLowerCase()}${error ? `: ${error}` : ""}`;
}

function timeAgo(atMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

import type { ScheduledTask, ScheduledTaskRecentRun } from "@goat/contracts";
import { runStatusPresentation } from "../scheduledTaskRun.ts";

/** How a dot draws its outcome. Shape and words carry it, never colour alone. */
export type RoutineRunShape =
  | "filled-circle"
  | "bar"
  | "filled-square"
  | "hollow-diamond"
  | "hollow-square";

export interface RoutineRunDot {
  readonly firingId: ScheduledTaskRecentRun["firingId"];
  /** The run's own status, for deciding what to show; `word` is only for reading. */
  readonly status: string;
  readonly quiet?: true;
  readonly dispatchFailed?: true;
  readonly shape: RoutineRunShape;
  /** The outcome in the last-run line's words, such as "completed", "dispatch failed" or "no update". */
  readonly word: string;
  readonly accessibleName: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  /** The bot conversation input to open; absent when the run never reached the bot. */
  readonly conversation?: NonNullable<ScheduledTaskRecentRun["conversation"]>;
}

const SHAPE_BY_TONE = {
  success: "filled-circle",
  error: "filled-square",
  warning: "filled-square",
  info: "hollow-diamond",
  outline: "hollow-square",
} as const satisfies Record<ReturnType<typeof runStatusPresentation>["tone"], RoutineRunShape>;

/** A routine's newest runs as dots, oldest to newest, at most `visible`; none from older servers. */
export function botRoutineRuns(
  task: Pick<ScheduledTask, "recentRuns">,
  visible: number,
  formatTime: (iso: string) => string,
): RoutineRunDot[] {
  return (task.recentRuns ?? [])
    .slice(0, Math.max(0, visible))
    .reverse()
    .map((run) => {
      const outcome = runStatusPresentation(run.status, run.dispatchFailed === true);
      const quiet = run.quiet === true && run.status === "completed";
      const word = quiet ? "no update" : outcome.label.toLowerCase();
      return {
        firingId: run.firingId,
        status: run.status,
        ...(run.quiet === true ? { quiet: true as const } : {}),
        ...(run.dispatchFailed === true ? { dispatchFailed: true as const } : {}),
        shape: quiet ? "bar" : SHAPE_BY_TONE[outcome.tone],
        word,
        accessibleName: `Run on ${formatTime(run.requestedAt)}, ${word}`,
        requestedAt: run.requestedAt,
        completedAt: run.completedAt,
        ...(run.conversation === undefined ? {} : { conversation: run.conversation }),
      };
    });
}

const IN_FLIGHT = new Set(["dispatching", "queued", "running"]);
const ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/**
 * Whether a run has an outcome to read. A status this client does not know may still be in
 * flight, so it counts as ended only once the run has a finish time.
 */
export function routineRunState(
  run: Pick<RoutineRunDot, "status" | "completedAt">,
): "in-flight" | "ended" | "unsettled" {
  if (IN_FLIGHT.has(run.status)) return "in-flight";
  if (ENDED.has(run.status) || run.completedAt !== null) return "ended";
  return "unsettled";
}

// Building an Intl formatter is costly on Hermes and a row formats every dot each minute.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (cached === undefined) {
    if (formatters.size >= 32) formatters.clear();
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * A run's time as short month, day, hour and minute, joined by a comma on every engine (some put
 * "at" between them); web passes its timestamp locale and hour form. `timeOnly` drops the date.
 */
export function routineRunTime(
  iso: string,
  options: {
    readonly locale?: string;
    readonly hour12?: boolean;
    readonly timeZone?: string;
    readonly timeOnly?: boolean;
  } = {},
): string {
  const at = Date.parse(iso);
  // A stored time is any string; Intl throws on NaN, and server text never reaches a spoken name.
  if (Number.isNaN(at)) return "Unknown time";
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const clock = {
    minute: "2-digit",
    ...(options.hour12 === undefined ? {} : { hour12: options.hour12 }),
    ...zone,
  } as const;
  // A 24-hour clock reads "09:00"; a 12-hour one reads "9:00 AM".
  const cycle = formatter(options.locale, { ...clock, hour: "numeric" }).resolvedOptions()
    .hourCycle;
  const hour = cycle === "h23" || cycle === "h24" ? "2-digit" : "numeric";
  const time = formatter(options.locale, { ...clock, hour }).format(at);
  if (options.timeOnly === true) return time;
  const day = formatter(options.locale, { month: "short", day: "numeric", ...zone });
  return `${day.format(at)}, ${time}`;
}

/**
 * When a run finished: "finished 4:09 AM" on the day it started, else with its date; null while
 * it runs. The day is read in the same locale and zone as the time.
 */
export function routineRunFinished(
  requestedAt: string,
  completedAt: string | null,
  options: { readonly locale?: string; readonly hour12?: boolean; readonly timeZone?: string } = {},
): string | null {
  if (completedAt === null) return null;
  const finish = Date.parse(completedAt);
  if (Number.isNaN(finish)) return "finished Unknown time";
  const start = Date.parse(requestedAt);
  const day = formatter(options.locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const sameDay = !Number.isNaN(start) && day.format(start) === day.format(finish);
  return `finished ${routineRunTime(completedAt, { ...options, timeOnly: sameDay })}`;
}

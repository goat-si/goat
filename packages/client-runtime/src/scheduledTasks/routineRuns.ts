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
        shape: quiet ? "bar" : SHAPE_BY_TONE[outcome.tone],
        word,
        accessibleName: `Run on ${formatTime(run.requestedAt)}, ${word}`,
        requestedAt: run.requestedAt,
        completedAt: run.completedAt,
        ...(run.conversation === undefined ? {} : { conversation: run.conversation }),
      };
    });
}

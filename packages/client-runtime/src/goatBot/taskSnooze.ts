import type { BotThreadRow, SnoozePresetSetting } from "@goat/contracts";
import { resolveSnoozePreset } from "../state/threadSettled.ts";

const presets = {
  hour: { kind: "after", minutes: 60 },
  tomorrow: { kind: "at", day: "tomorrow", time: "09:00" },
  week: { kind: "at", day: "monday", time: "09:00" },
} as const satisfies Record<string, SnoozePresetSetting>;

export const BOT_TASK_SNOOZE_CHOICES = [
  { id: "hour", label: "1 hour" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "Next week" },
] as const;

export function botTaskSnoozeUntil(choice: string, now: Date): string | undefined {
  const preset = BOT_TASK_SNOOZE_CHOICES.find(({ id }) => id === choice);
  return preset === undefined
    ? undefined
    : resolveSnoozePreset(presets[preset.id], now)?.snoozedUntil;
}

/** History stays browsable when a task is outside the bounded current-list fold. */
export function withoutSnoozedBotTasks(
  rows: ReadonlyArray<BotThreadRow>,
  snoozed: ReadonlyArray<Extract<BotThreadRow, { kind: "task" }>>,
) {
  const hidden = new Set(snoozed.map((row) => row.task.taskId));
  return rows.flatMap<BotThreadRow>((row) => {
    const id = row.kind === "task" ? row.task.taskId : row.taskId;
    if (hidden.has(id)) return [];
    if (row.kind !== "task" || row.view.snoozedUntil === undefined) return [row];
    // The detail read supplies the live snooze for actions on an older task.
    const { snoozedUntil: _cached, ...view } = row.view;
    return [{ ...row, view }];
  });
}

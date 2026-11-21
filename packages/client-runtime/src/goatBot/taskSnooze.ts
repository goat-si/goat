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

export function withoutSnoozedBotTasks(
  rows: ReadonlyArray<BotThreadRow>,
  snoozed: ReadonlyArray<Extract<BotThreadRow, { kind: "task" }>>,
) {
  const hidden = new Set(snoozed.map((row) => row.task.taskId));
  for (const row of rows)
    if (row.kind === "task" && row.view.snoozedUntil !== undefined) hidden.add(row.task.taskId);
  return rows.filter((row) => !hidden.has(row.kind === "task" ? row.task.taskId : row.taskId));
}

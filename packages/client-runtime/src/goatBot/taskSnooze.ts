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

/** Apply the latest fold to history, whose task views may predate a snooze or wake. */
export function withoutSnoozedBotTasks(
  rows: ReadonlyArray<BotThreadRow>,
  snoozed: ReadonlyArray<Extract<BotThreadRow, { kind: "task" }>>,
  truncated: boolean,
) {
  const hidden = new Set(snoozed.map((row) => row.task.taskId));
  const cutoff = snoozed.at(-1)?.view.snoozedUntil;
  const wake = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "task" || row.view.snoozedUntil === undefined) continue;
    const id = row.task.taskId;
    // An incomplete fold may have omitted this historical snooze.
    if (truncated && (cutoff === undefined || row.view.snoozedUntil >= cutoff)) hidden.add(id);
    else if (!hidden.has(id)) wake.add(id);
  }
  return rows.flatMap<BotThreadRow>((row) => {
    const id = row.kind === "task" ? row.task.taskId : row.taskId;
    if (hidden.has(id)) return [];
    if (row.kind !== "task" || !wake.has(id)) return [row];
    const { snoozedUntil: _expired, ...view } = row.view;
    return [{ ...row, view }];
  });
}

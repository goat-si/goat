import { scheduleTimeZoneLabel } from "../scheduledTaskTimeZone.ts";
import type { ScheduledTaskSchedule } from "@goat/contracts";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
  formatTime: (value: string) => string = (value) => value,
  labels?: {
    readonly webhook: string;
    readonly minutes: (count: number) => string;
    readonly seconds: (count: number) => string;
    readonly daily: string;
    readonly weekdays: string;
    readonly locale: string;
    readonly at: (days: string, time: string) => string;
  },
): string {
  if (schedule.type === "webhook") return labels?.webhook ?? "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    if (Number.isInteger(minutes)) return labels?.minutes(minutes) ?? `Every ${minutes} min`;
    const seconds = Math.round(schedule.everyMs / 1000);
    return labels?.seconds(seconds) ?? `Every ${seconds} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const weekday = labels
    ? new Intl.DateTimeFormat(labels.locale, { weekday: "short", timeZone: "UTC" })
    : null;
  const days =
    weekdays.length === 0
      ? (labels?.daily ?? "Daily")
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? (labels?.weekdays ?? "Weekdays")
        : labels && weekday
          ? new Intl.ListFormat(labels.locale, { type: "unit", style: "short" }).format(
              weekdays.map((day) => weekday.format(Date.UTC(2023, 0, 1 + day))),
            )
          : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = scheduleTimeZoneLabel(timeZone, runAt, labels?.locale);
  const time = [formatTime(schedule.timeOfDay), zone].filter(Boolean).join(" ");
  return labels?.at(days, time) ?? `${days} at ${time}`;
}

/** Label for a positive delay until an upcoming run, such as "in 3h". */
export function formatTimeUntil(diffMs: number): string {
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

import { scheduleTimeZoneLabel } from "../scheduledTaskTimeZone.ts";
import type { ScheduledTaskSchedule } from "@goat/contracts";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  return `${days} at ${schedule.timeOfDay}${zone === undefined ? "" : ` ${zone}`}`;
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

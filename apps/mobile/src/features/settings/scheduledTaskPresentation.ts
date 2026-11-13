import type { ScheduledTask } from "@goat/contracts";
import { scheduleTimeZoneLabel } from "@goat/client-runtime/scheduledTasks";
import { presentMemoryRunAccess } from "@goat/client-runtime/memory-presentation";

export function scheduledMemoryAccess(input: Parameters<typeof presentMemoryRunAccess>[0]) {
  const view = presentMemoryRunAccess(input);
  if (input.memoryGrantCeiling === undefined && view.effectiveAccess === "unknown") return null;
  const labels = { none: "None", read: "Read only", read_write: "Read and write" };
  const reasons = {
    policy_unready: "Policy is not ready",
    environment_off: "Agent memory access is off",
    legacy_none: "No saved access",
    ceiling: "Within the saved limit",
    read_only_destination: "Destination allows reading only",
    dispatch_scope: "Limited by dispatch permissions",
  };
  return `${view.savedCeilingLabel}${view.effectiveAccess === "unknown" ? "" : ` · Allowed now: ${labels[view.effectiveAccess]}${view.effectiveReason ? ` (${reasons[view.effectiveReason]})` : ""}`}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Next run unavailable";
  if (remaining <= 0) return "Next run due";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Next run in less than a minute";
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return `Next run in ${count} ${unit}${count === 1 ? "" : "s"}`;
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return `Next run tomorrow at ${time}`;
  if (days <= 7) {
    return `Next run next ${next.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Next run ${date} at ${time}`;
}

export const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

export function describeSchedule(task: ScheduledTask, timeZone?: string): string {
  if (task.schedule.type === "webhook") return "On webhook";
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length ? repeatLabel(task.schedule.weekdays) : "Every day";
  const zone = scheduleTimeZoneLabel(timeZone, task.nextRunAt);
  return `${days} at ${formatTime(task.schedule.timeOfDay)}${zone === undefined ? "" : ` ${zone}`}`;
}

export function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

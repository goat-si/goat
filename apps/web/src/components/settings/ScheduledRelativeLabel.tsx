import { useGT, useLocale } from "gt-react";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatScheduledRelativeTime } from "./scheduledTasksSettings.logic";

// The minute tick keeps relative labels fresh without a timer for each task.
export function ScheduledRelativeLabel({ value }: { readonly value: string | null }) {
  const gt = useGT();
  const locale = useLocale();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const diff = value === null ? NaN : Date.parse(value) - now;
  if (!Number.isFinite(diff)) return gt("Not scheduled");
  if (diff > 0 && Math.ceil(diff / 60_000) < 2) return gt("in under a minute");
  return formatScheduledRelativeTime(diff, locale);
}

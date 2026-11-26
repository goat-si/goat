import { useGT, useLocale } from "gt-react";
import { useNowMinute } from "~/hooks/useNowMinute";

// The minute tick keeps relative labels fresh without a timer for each task.
export function ScheduledRelativeLabel({ value }: { readonly value: string | null }) {
  const gt = useGT();
  const locale = useLocale();
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const diff = value === null ? NaN : Date.parse(value) - now;
  if (!Number.isFinite(diff)) return gt("Not scheduled");
  if (diff > 0 && Math.ceil(diff / 60_000) < 2) return gt("in under a minute");
  const minutes = Math.ceil(diff / 60_000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes === 0) return relative.format(0, "second");
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = diff > 0 ? Math.round(minutes / 60) : Math.ceil(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(diff > 0 ? Math.round(hours / 24) : Math.ceil(hours / 24), "day");
}

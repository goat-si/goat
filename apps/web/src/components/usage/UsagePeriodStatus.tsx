import type { UsageSummaryInput } from "@goat/contracts";
import { useGT, useLocale } from "gt-react";

function formatPeriod(window: UsageSummaryInput, locale: string, hour12: boolean) {
  const { sinceTime, untilTime, sinceDay, untilDay, timeZone } = window;
  if (sinceTime !== undefined && untilTime !== undefined) {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      timeZone,
      hour12,
    }).formatRange(new Date(sinceTime), new Date(untilTime));
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).formatRange(new Date(sinceDay), new Date(untilDay));
}

export function UsagePeriodStatus({
  loading,
  failed,
  previousWindow,
  hour12,
}: {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly previousWindow: UsageSummaryInput | undefined;
  readonly hour12: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  return (
    <div role="status">
      {loading || failed ? (
        <p className="mx-auto flex w-full max-w-5xl flex-wrap gap-x-2 px-5 pt-4 text-sm text-muted-foreground sm:px-6">
          <span>
            {failed
              ? gt("Could not load usage for the selected period.")
              : gt("Loading usage for the selected period…")}
          </span>
          {previousWindow ? (
            <span>
              {gt("Showing {range}.", { range: formatPeriod(previousWindow, locale, hour12) })}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

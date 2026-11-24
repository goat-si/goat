import { useState } from "react";
import { makeWindow } from "@goat/shared/usageFormat";

import { useDebouncedValue } from "../../state/queries";
import type { UsagePagePreferences } from "./usagePagePreferences";

type PeriodDays = UsagePagePreferences["windowDays"];

function periodWindow(days: PeriodDays) {
  return makeWindow(days, undefined, days === 1 ? "hour" : "day");
}

export function useUsagePeriod(days: PeriodDays) {
  const queryDays = useDebouncedValue(days, 200);
  const [selection, setSelection] = useState(() => ({ days, window: periodWindow(days) }));
  const window = queryDays === selection.days ? selection.window : periodWindow(queryDays);
  if (queryDays !== selection.days) setSelection({ days: queryDays, window });

  return {
    window,
    periodSelectionPending: days !== queryDays,
    refreshPeriod: () => {
      const next = periodWindow(queryDays);
      if (
        next.sinceDay !== window.sinceDay ||
        next.untilDay !== window.untilDay ||
        next.sinceTime !== window.sinceTime ||
        next.untilTime !== window.untilTime ||
        next.timeZone !== window.timeZone
      ) {
        setSelection({ days: queryDays, window: next });
      }
      return next;
    },
  };
}

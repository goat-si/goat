import type { RunId } from "@goat/contracts";

import type { TimelineEntry } from "../../session-logic";
import type { TimelineLatestRun } from "./timelineLatestRun";

export function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

export function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

/** Usage-limit pauses keep their tool groups; any other failure itemizes the run's work. */
export function itemizedFailedRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  failedRunIds: ReadonlySet<RunId>,
  usageLimitRunId: RunId | null = null,
) {
  const usageLimited = new Set<RunId>(usageLimitRunId ? [usageLimitRunId] : []);
  const otherFailures = new Set<RunId>();
  for (const entry of entries) {
    const item = timelineEntryFailedItem(entry);
    if (item?.runId) {
      (item.failure.class === "usage_limit" ? usageLimited : otherFailures).add(item.runId);
    }
  }
  return new Set(
    [...failedRunIds].filter((runId) => !usageLimited.has(runId) || otherFailures.has(runId)),
  );
}

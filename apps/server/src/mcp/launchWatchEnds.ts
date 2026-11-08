import type { RunId } from "@goat/contracts";

import {
  endReported,
  type LaunchWatch,
  recordContact,
  settleEnd,
  settleRun,
  skipRun,
  type WatchedRun,
  wentOnFrom,
} from "./launchWatch.ts";

/**
 * Settles a followed run's end that needs no report: its end, or the run a promoted message joined,
 * was reported already, or the thread went straight on. While the run it went on to is still
 * queued, `again` has the end read once more, as that run may be dropped before it starts.
 */
export function quietEnd(
  watch: LaunchWatch,
  runId: RunId,
  ended: { readonly runId: RunId; readonly end: string | null },
  runs: ReadonlyArray<WatchedRun>,
  now: number,
): { readonly watch: LaunchWatch; readonly again: boolean } | undefined {
  const contacted = recordContact(watch, now);
  if (ended.runId !== runId) {
    return watch.reportedRuns.includes(ended.runId) || endReported(watch, ended.runId, ended.end)
      ? { watch: settleRun(contacted, runId, now), again: false }
      : undefined;
  }
  // A retry that arrived meanwhile still has the run followed once more.
  if (endReported(watch, runId, ended.end))
    return { watch: settleEnd(contacted, runId, ended.end, now), again: false };
  const next = wentOnFrom(watch, runId, runs);
  if (next === false) return undefined;
  return next === true
    ? { watch: skipRun(contacted, runId, now), again: false }
    : { watch: contacted, again: true };
}

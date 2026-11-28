import type { OrchestrationV2TurnItem } from "@goat/contracts";

/** Lines an edit added and removed. The server counts them once at ingest. */
export interface WorkLogLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * The counts to show beside an edit row: none for other items, failed edits,
 * providers that did not report counts, or an edit that changed no lines.
 */
export function fileChangeLineCounts(
  item: OrchestrationV2TurnItem | undefined,
): WorkLogLineCounts | undefined {
  if (item?.type !== "file_change" || item.status === "failed") return undefined;
  const additions = item.additions ?? 0;
  const deletions = item.deletions ?? 0;
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

/**
 * Totals for a group of edits. A partial sum would understate the change, so
 * the group shows totals only when every edit in it reported counts.
 */
export function fileChangeGroupLineCounts(
  items: Iterable<OrchestrationV2TurnItem | undefined>,
): WorkLogLineCounts | undefined {
  let additions = 0;
  let deletions = 0;
  for (const item of items) {
    if (item?.type !== "file_change" || item.status === "failed") continue;
    if (item.additions === undefined && item.deletions === undefined) return undefined;
    additions += item.additions ?? 0;
    deletions += item.deletions ?? 0;
  }
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

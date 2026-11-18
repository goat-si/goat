import type { OrchestratorMcpThreadListItem } from "@goat/contracts";

type ListItem = OrchestratorMcpThreadListItem;

/** Newest first, as each environment lists its own; the host breaks the last tie. */
const newestFirst = (left: ListItem, right: ListItem) =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  right.threadId.localeCompare(left.threadId) ||
  (left.host ?? "").localeCompare(right.host ?? "");

/**
 * Merges the first `limit` threads of each environment into the first
 * `limit` overall. Each list must hold its own newest threads in the order
 * `newestFirst` uses, which makes the merged page exact.
 */
export function mergeHostThreadLists(
  lists: ReadonlyArray<{ readonly threads: ReadonlyArray<ListItem>; readonly total: number }>,
  limit: number,
): { readonly threads: Array<ListItem>; readonly total: number; readonly truncated: boolean } {
  const threads = lists
    .flatMap((list) => list.threads)
    .toSorted(newestFirst)
    .slice(0, limit);
  const total = lists.reduce((sum, list) => sum + list.total, 0);
  return { threads, total, truncated: total > threads.length };
}

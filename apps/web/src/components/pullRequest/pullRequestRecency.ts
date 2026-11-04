import type { PullRequestListEntry } from "@goat/contracts";
import { toSortableTimestamp } from "../../lib/threadSort";

export function comparePullRequestsByRecency(
  left: PullRequestListEntry,
  right: PullRequestListEntry,
) {
  const leftUpdated = toSortableTimestamp(left.updatedAt);
  const rightUpdated = toSortableTimestamp(right.updatedAt);
  const measured = Number(leftUpdated === null) - Number(rightUpdated === null);
  if (measured !== 0) return measured;
  if (leftUpdated === null || rightUpdated === null) return 0;
  return rightUpdated - leftUpdated;
}

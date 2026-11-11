import type { SidebarPriorityHolds } from "./Sidebar.logic";

export function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function sameHolds(left: SidebarPriorityHolds, right: SidebarPriorityHolds): boolean {
  if (left.size !== right.size) return false;
  for (const [key, settledOverride] of left) {
    if (!right.has(key) || right.get(key) !== settledOverride) return false;
  }
  return true;
}

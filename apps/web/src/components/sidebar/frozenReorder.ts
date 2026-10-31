import { planPinnedReorder } from "@goat/client-runtime/state/thread-sort";
export function crossesFrozenKeylessBoundary(
  order: readonly string[],
  keysById: ReadonlyMap<string, string | null | undefined>,
  writable: ReadonlySet<string>,
  assignments: ReadonlyArray<{ id: string }>,
  section: "active" | "pinned" | "settled",
) {
  // Keyless Active rows sort before keyed rows; keyless Pinned rows sort after them.
  // Materializing any row across a frozen keyless boundary cannot persist that position.
  const assignedIds = new Set(assignments.map(({ id }) => id));
  let hasFrozenKeylessBefore = false;
  let hasAssignedBefore = false;
  for (const id of order) {
    const isFrozenKeyless = !writable.has(id) && keysById.get(id) == null;
    const isAssigned = assignedIds.has(id);
    if (
      (section === "active" && isFrozenKeyless && hasAssignedBefore) ||
      (section === "pinned" && isAssigned && hasFrozenKeylessBefore)
    ) {
      return true;
    }

    hasFrozenKeylessBefore ||= isFrozenKeyless;
    hasAssignedBefore ||= isAssigned;
  }

  return false;
}

export function arrangeSidebarReorder(
  activeKey: string,
  section: "active" | "pinned" | "settled",
  order: readonly string[],
  keysById: ReadonlyMap<string, string | null | undefined>,
  writable: ReadonlySet<string> | undefined,
) {
  if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
  if (!writable.has(activeKey)) return null;
  const assignments = planPinnedReorder({
    orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
    keysById,
    movedId: activeKey,
  });
  return assignments.some(({ id }) => !writable.has(id)) ||
    crossesFrozenKeylessBoundary(order, keysById, writable, assignments, section)
    ? null
    : assignments;
}

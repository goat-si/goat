/**
 * Rows each mounted thread list holds in Priority after they were read. Reorder paths outside the
 * list (row menus, Arrange threads, pending order) leave them out, as the list does.
 */
const heldByList = new Map<string, ReadonlySet<string>>();
let held: ReadonlySet<string> = new Set();

export function publishHeldPriorityKeys(listId: string, keys: ReadonlySet<string> | null): void {
  if (keys === null) heldByList.delete(listId);
  else heldByList.set(listId, keys);
  held = new Set([...heldByList.values()].flatMap((listKeys) => [...listKeys]));
}

export const heldPriorityKeys = (): ReadonlySet<string> => held;

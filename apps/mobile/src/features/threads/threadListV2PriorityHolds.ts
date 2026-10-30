/**
 * Rows each mounted thread list holds in Priority after they were read. Reorder paths outside the
 * list (row menus, Arrange threads, pending order) leave them out, as the list does.
 */
const heldByList = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let held: ReadonlySet<string> = new Set();
let heldByOthers = new Map<string, ReadonlySet<string>>();

export function publishHeldPriorityKeys(listId: string, keys: ReadonlySet<string> | null): void {
  if (keys === null) heldByList.delete(listId);
  else heldByList.set(listId, keys);
  held = new Set([...heldByList.values()].flatMap((listKeys) => [...listKeys]));
  heldByOthers = new Map();
  for (const listener of listeners) listener();
}

/**
 * Held rows across mounted lists. A list passes its own id: it excludes its current Priority rows
 * itself, and its published keys lag a render behind.
 */
export function heldPriorityKeys(exceptListId?: string): ReadonlySet<string> {
  if (exceptListId === undefined || !heldByList.has(exceptListId)) return held;
  let others = heldByOthers.get(exceptListId);
  if (others === undefined) {
    others = new Set(
      [...heldByList].flatMap(([listId, keys]) => (listId === exceptListId ? [] : [...keys])),
    );
    heldByOthers.set(exceptListId, others);
  }
  return others;
}

export function subscribeHeldPriorityKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

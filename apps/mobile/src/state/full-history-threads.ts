import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

// Threads whose next send keeps the full history instead of compacting first.
export const fullHistoryThreadKeysAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
);

export function setKeepFullHistory(threadKey: string, keep: boolean) {
  const { [threadKey]: kept, ...rest } = appAtomRegistry.get(fullHistoryThreadKeysAtom);
  if ((kept === true) === keep) return;
  appAtomRegistry.set(fullHistoryThreadKeysAtom, keep ? { ...rest, [threadKey]: true } : rest);
}

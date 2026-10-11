import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { buildSidebarDelegatedChildIndex, type SidebarDelegatedChildren } from "../Sidebar.logic";

type DelegatedChildIndex = ReadonlyMap<string, SidebarDelegatedChildren<EnvironmentThreadShell>>;

// Derived once per shell-list change. The previous index lets unchanged parents
// keep their entry object, so their memoized sidebar rows skip re-rendering when
// an unrelated shell updates.
const delegatedChildIndexAtom = (() => {
  let previous: DelegatedChildIndex = new Map();
  return Atom.make((get) => {
    previous = buildSidebarDelegatedChildIndex(
      get(environmentThreadShells.threadShellsAtom),
      previous,
    );
    return previous;
  }).pipe(Atom.withLabel("web-sidebar-delegated-child-index"));
})();

/** Delegated task children of every thread, keyed by the parent's scoped thread key. */
export function useSidebarDelegatedChildIndex(): DelegatedChildIndex {
  return useAtomValue(delegatedChildIndexAtom);
}

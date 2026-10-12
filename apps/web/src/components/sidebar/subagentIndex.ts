import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { buildSidebarSubagentIndex, type SidebarSubagentIndex } from "../Sidebar.logic";

// Derived once per shell-list change. Unchanged maps keep their identity, so a
// streaming subagent does not re-render its owner row until its owner or pending
// request changes.
const subagentIndexAtom = (() => {
  let previous: SidebarSubagentIndex | undefined;
  return Atom.make((get) => {
    previous = buildSidebarSubagentIndex(get(environmentThreadShells.threadShellsAtom), previous);
    return previous;
  }).pipe(Atom.withLabel("web-sidebar-subagent-index"));
})();

/** Owner rows of every live subagent, and the subagent requests each owner carries. */
export function useSidebarSubagentIndex(): SidebarSubagentIndex {
  return useAtomValue(subagentIndexAtom);
}

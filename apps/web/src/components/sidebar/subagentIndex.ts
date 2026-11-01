import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { Atom } from "effect/reactivity";

import { useThreadShell } from "../../state/entities";
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

/** The open subagent and the row that owns it, or null when the open thread has a row. */
export function useSidebarOpenSubagent(
  routeThreadKey: string | null,
): { readonly ownerKey: string; readonly thread: EnvironmentThreadShell } | null {
  const ownerKey = useSidebarSubagentIndex().ownerKeyByChildKey.get(routeThreadKey ?? "") ?? null;
  const ref =
    ownerKey === null || routeThreadKey === null ? null : parseScopedThreadKey(routeThreadKey);
  const thread = useThreadShell(ref);
  return ownerKey === null || thread === null ? null : { ownerKey, thread };
}

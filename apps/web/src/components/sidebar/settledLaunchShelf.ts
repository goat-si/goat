import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import type { LaunchFold } from "@goat/client-runtime/state/launch-fold";
import type { SidebarSection } from "../Sidebar.logic";

export function resolveNestedRowVariant(
  section: SidebarSection,
  parentVariant?: "card" | "slim",
): "card" | "slim" {
  return section === "priority" ||
    section === "pinned" ||
    section === "active" ||
    (section === "settled" && parentVariant === "card")
    ? "card"
    : "slim";
}

type ShelfThread = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const keyOf = (thread: ShelfThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function projectSettledLaunchShelf<T extends ShelfThread>(input: {
  readonly roots: readonly T[];
  readonly fold: Pick<LaunchFold<T>, "childrenByParentKey" | "folded">;
  readonly all: readonly T[];
  readonly isListed: (thread: T) => boolean;
  readonly unloadedCount: (threads: readonly T[]) => number;
  readonly visibleCount: number;
  readonly routeKey: string | null;
  readonly expanded: boolean;
}) {
  const listed = (thread: T): boolean =>
    input.isListed(thread) ||
    (input.fold.childrenByParentKey.get(keyOf(thread)) ?? []).some(listed);
  const listedRoots = input.roots.filter(listed);
  const visible = listedRoots.slice(0, input.visibleCount);
  if (input.routeKey !== null && !visible.some((thread) => keyOf(thread) === input.routeKey)) {
    const routed = input.roots.find((thread) => keyOf(thread) === input.routeKey);
    if (routed !== undefined) visible.push(routed);
  }
  const rendered = input.expanded
    ? visible
    : visible.filter((thread) => keyOf(thread) === input.routeKey);
  return {
    listed: listedRoots,
    visible,
    rendered,
    count: input.roots.length + input.unloadedCount(input.all),
    searchable: [...input.roots, ...input.fold.folded],
  };
}

import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { launchAncestorKeys, type LaunchFold, type LaunchFoldThread } from "./launchFold";

const EXPANDED_KEY = "goat:sidebar:launch-groups-expanded";
const ExpandedRecord = Schema.Record(Schema.String, Schema.Boolean);
const NO_EXPANDED: Readonly<Record<string, boolean>> = {};
const NO_KEYS: ReadonlySet<string> = new Set();
/** Children a group lists before "+N more". */
const LAUNCH_GROUP_CHILD_LIMIT = 5;

// Every list that draws or orders launch groups reads one session state, so "+N more" and a
// collapse made while a folded thread is open agree between the rows and keyboard order.
interface LaunchGroupSession {
  readonly showAll: ReadonlySet<string>;
  readonly route: string | null;
  readonly routeCollapsed: ReadonlySet<string>;
}
let session: LaunchGroupSession = { showAll: new Set(), route: null, routeCollapsed: new Set() };
const sessionListeners = new Set<() => void>();
function setSession(next: LaunchGroupSession) {
  session = next;
  for (const listener of sessionListeners) listener();
}
const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
};
const readSession = () => session;

/** Tests start each case from a fresh session. */
export function resetLaunchGroupSession() {
  setSession({ showAll: new Set(), route: null, routeCollapsed: new Set() });
}

const keyOf = (thread: Pick<LaunchFoldThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export interface LaunchGroups<T> {
  /** Launcher keys above a folded thread, nearest first. */
  readonly ancestorKeys: (key: string) => readonly string[];
  readonly isExpanded: (parentKey: string) => boolean;
  readonly toggle: (parentKey: string) => void;
  readonly showAll: (parentKey: string) => void;
  /** The children a group renders now: none when collapsed, else up to the limit. */
  readonly shownChildren: (parentKey: string) => readonly T[];
  /** Top-level keys followed by each shown child, depth first: the order rows appear in. */
  readonly renderedOrder: (rootKeys: readonly string[]) => readonly string[];
}

/**
 * Expansion per launcher row, remembered across sessions. Opening a folded thread expands every
 * group on its path; collapsing one of those while it is open holds until the route changes.
 */
export function useLaunchGroups<T extends LaunchFoldThread>(
  fold: Pick<LaunchFold<T>, "childrenByParentKey" | "parentKeyByKey">,
  routeThreadKey: string | null,
): LaunchGroups<T> {
  const [stored, setStored] = useLocalStorage(EXPANDED_KEY, NO_EXPANDED, ExpandedRecord);
  const current = useSyncExternalStore(subscribeSession, readSession, readSession);
  const showAllKeys = current.showAll;
  // A collapse made while a folded thread is open lasts until the route changes.
  const routeCollapsed = current.route === routeThreadKey ? current.routeCollapsed : NO_KEYS;
  const routeAncestors = routeThreadKey === null ? [] : launchAncestorKeys(fold, routeThreadKey);
  const routePath = new Set(routeThreadKey === null ? [] : [routeThreadKey, ...routeAncestors]);
  const pendingReveal = routeAncestors.filter(
    (key) => stored[key] !== true && !routeCollapsed.has(key),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Opening a folded thread writes its groups' expansion to storage, so they stay open after navigating away.
  useEffect(() => {
    if (pendingReveal.length === 0) return;
    setStored((current) => ({
      ...current,
      ...Object.fromEntries(pendingReveal.map((key) => [key, true])),
    }));
  }, [pendingReveal, setStored]);
  const isExpanded = (parentKey: string) =>
    routeAncestors.includes(parentKey)
      ? !routeCollapsed.has(parentKey)
      : stored[parentKey] === true;
  const shownChildren = (parentKey: string): readonly T[] => {
    const children = fold.childrenByParentKey.get(parentKey) ?? [];
    if (!isExpanded(parentKey)) return [];
    if (showAllKeys.has(parentKey)) return children;
    // The child on the routed thread's path stays listed, however deep the route is.
    const routeIndex = children.findIndex((child) => routePath.has(keyOf(child)));
    return children.slice(0, Math.max(LAUNCH_GROUP_CHILD_LIMIT, routeIndex + 1));
  };
  return {
    ancestorKeys: (key) => launchAncestorKeys(fold, key),
    isExpanded,
    toggle: (parentKey) => {
      const next = !isExpanded(parentKey);
      if (routeAncestors.includes(parentKey)) {
        const keys = new Set(routeCollapsed);
        if (next) keys.delete(parentKey);
        else keys.add(parentKey);
        setSession({ ...session, route: routeThreadKey, routeCollapsed: keys });
      }
      setStored((current) =>
        Object.fromEntries([
          ...Object.entries(current).filter(([key]) => key !== parentKey),
          ...(next ? [[parentKey, true] as const] : []),
        ]),
      );
    },
    showAll: (parentKey) =>
      setSession({ ...session, showAll: new Set([...session.showAll, parentKey]) }),
    shownChildren,
    renderedOrder: (rootKeys) => {
      const order: string[] = [];
      const visit = (key: string) => {
        order.push(key);
        for (const child of shownChildren(key)) visit(keyOf(child));
      };
      for (const key of rootKeys) visit(key);
      return order;
    },
  };
}

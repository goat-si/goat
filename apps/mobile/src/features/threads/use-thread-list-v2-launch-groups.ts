import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { ThreadListV2LaunchGroupState } from "./threadListV2LaunchFold";

const NO_EXPANDED: Readonly<Record<string, boolean>> = {};
const NO_KEYS: ReadonlySet<string> = new Set();

// Home and the thread sidebar read one session, so "+N more" and a collapse made while a folded
// thread is selected agree between them. A collapse lasts while some list has that thread selected.
interface LaunchGroupSession {
  readonly showAll: ReadonlySet<string>;
  /** Groups collapsed above a selected thread, by that thread's key. */
  readonly routeCollapsed: ReadonlyMap<string, ReadonlySet<string>>;
}
const NO_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map();
let session: LaunchGroupSession = { showAll: NO_KEYS, routeCollapsed: NO_ROUTES };
const listeners = new Set<() => void>();
function setSession(next: LaunchGroupSession) {
  session = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readSession = () => session;

// Each mounted list's selected thread; overrides for threads no list selects are dropped.
const selections = new Map<symbol, string | null>();
function forgetUnselectedRoutes() {
  const selected = new Set(selections.values());
  if ([...session.routeCollapsed.keys()].every((route) => selected.has(route))) return;
  setSession({
    ...session,
    routeCollapsed: new Map([...session.routeCollapsed].filter(([route]) => selected.has(route))),
  });
}

/** Tests start each case from a fresh session. */
export function resetThreadListV2LaunchGroupSession() {
  selections.clear();
  setSession({ showAll: NO_KEYS, routeCollapsed: NO_ROUTES });
}

const withKey = (record: Readonly<Record<string, boolean>>, key: string, on: boolean) =>
  Object.fromEntries([
    ...Object.entries(record).filter(([entry]) => entry !== key),
    ...(on ? [[key, true] as const] : []),
  ]);

/**
 * Launch group expansion, remembered on this device. Selecting a folded thread expands the
 * groups above it; collapsing one of those holds until the selection changes.
 */
export function useThreadListV2LaunchGroups(selectedThreadKey: string | null) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const expanded =
    (loaded ? preferencesResult.value.threadListLaunchGroupsExpanded : undefined) ?? NO_EXPANDED;
  const current = useSyncExternalStore(subscribe, readSession, readSession);
  // oxlint-disable-next-line goat/react-effect-budget -- Registers this list's selection so the shared session forgets collapses for threads no list selects anymore.
  useEffect(() => {
    const list = Symbol("launch-group-list");
    selections.set(list, selectedThreadKey);
    return () => {
      selections.delete(list);
      // After the whole commit, so a list taking over this thread registers before the check.
      queueMicrotask(forgetUnselectedRoutes);
    };
  }, [selectedThreadKey]);
  const routeCollapsed =
    selectedThreadKey === null
      ? NO_KEYS
      : (current.routeCollapsed.get(selectedThreadKey) ?? NO_KEYS);
  const state: ThreadListV2LaunchGroupState = {
    expanded,
    showAll: current.showAll,
    routeCollapsed,
  };
  return {
    loaded,
    state,
    /** `onRoute`: the group sits above the selected thread. */
    toggle: (parentKey: string, isExpanded: boolean, onRoute: boolean) => {
      if (!loaded) return;
      const next = !isExpanded;
      if (onRoute && selectedThreadKey !== null) {
        const keys = new Set(routeCollapsed);
        if (next) keys.delete(parentKey);
        else keys.add(parentKey);
        setSession({
          ...session,
          routeCollapsed: new Map([...session.routeCollapsed, [selectedThreadKey, keys]]),
        });
      }
      savePreferences({
        transform: (preferences) => ({
          threadListLaunchGroupsExpanded: withKey(
            preferences.threadListLaunchGroupsExpanded ?? NO_EXPANDED,
            parentKey,
            next,
          ),
        }),
      });
    },
    showAll: (parentKey: string) =>
      setSession({ ...session, showAll: new Set([...session.showAll, parentKey]) }),
    /** Remembers groups opened for a selected folded thread, so they stay open after it. */
    reveal: (keys: readonly string[]) => {
      if (!loaded || keys.length === 0) return;
      savePreferences({
        transform: (preferences) => ({
          threadListLaunchGroupsExpanded: {
            ...preferences.threadListLaunchGroupsExpanded,
            ...Object.fromEntries(keys.map((key) => [key, true])),
          },
        }),
      });
    },
  };
}

/**
 * Remembers the groups above a selected folded thread once preferences load, so they stay open
 * after it. `keys` are the layout's launchRevealKeys.
 */
export function useRevealLaunchGroups(
  groups: Pick<ReturnType<typeof useThreadListV2LaunchGroups>, "loaded" | "reveal">,
  keys: readonly string[],
) {
  const joined = keys.join("\n");
  const { loaded, reveal } = groups;
  // oxlint-disable-next-line goat/react-effect-budget -- Selecting a folded thread writes its groups' expansion to device preferences, so they stay open after it.
  useEffect(() => {
    if (loaded && joined.length > 0) reveal(joined.split("\n"));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reveal is rebuilt each render; the keys and loading decide.
  }, [joined, loaded]);
}

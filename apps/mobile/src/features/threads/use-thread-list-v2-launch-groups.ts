import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { ThreadListV2LaunchGroupState } from "./threadListV2LaunchFold";

const NO_EXPANDED: Readonly<Record<string, boolean>> = {};
const NO_KEYS: ReadonlySet<string> = new Set();

// Home and the thread sidebar read one session, so "+N more" and a collapse made while a folded
// thread is selected agree between them.
interface LaunchGroupSession {
  readonly showAll: ReadonlySet<string>;
  readonly route: string | null;
  readonly routeCollapsed: ReadonlySet<string>;
}
let session: LaunchGroupSession = { showAll: NO_KEYS, route: null, routeCollapsed: NO_KEYS };
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

/** Tests start each case from a fresh session. */
export function resetThreadListV2LaunchGroupSession() {
  setSession({ showAll: NO_KEYS, route: null, routeCollapsed: NO_KEYS });
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
  const state: ThreadListV2LaunchGroupState = {
    expanded,
    showAll: current.showAll,
    routeCollapsed: current.route === selectedThreadKey ? current.routeCollapsed : NO_KEYS,
  };
  return {
    loaded,
    state,
    /** `onRoute`: the group sits above the selected thread. */
    toggle: (parentKey: string, isExpanded: boolean, onRoute: boolean) => {
      if (!loaded) return;
      const next = !isExpanded;
      if (onRoute) {
        const keys = new Set(state.routeCollapsed);
        if (next) keys.delete(parentKey);
        else keys.add(parentKey);
        setSession({ ...session, route: selectedThreadKey, routeCollapsed: keys });
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

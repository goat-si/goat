import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useNavigation,
  useNavigationState,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import type { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { resolveGoatBotHomeSelection } from "@goat/client-runtime/goatBot";
import { useMobileGoatBotEnvironments } from "./useMobileGoatBotEnvironments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { effectiveHomeMode, mobileGoatBotKnown, mobileGoatBotDetailOpen } from "./goatBotHomeMode";

let advertised: ReadonlySet<EnvironmentId> = new Set();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => advertised;

/** Connection loss does not erase a capability already advertised in this app session. */
export function useMobileGoatBotHomeMode() {
  const result = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const environments = useMobileGoatBotEnvironments();
  const advertisedEnvironments = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    const next = new Set(advertised);
    for (const environment of environments) {
      if (environment.supportsChannelLedger && !advertised.has(environment.environmentId)) {
        next.add(environment.environmentId);
      }
    }
    if (next.size !== advertised.size) {
      advertised = next;
      for (const listener of listeners) listener();
    }
  }, [environments]);
  const loaded = AsyncResult.isSuccess(result);
  const preferences = loaded ? result.value : null;
  const botRef = preferences?.goatBotRef ?? null;
  const home = resolveGoatBotHomeSelection(environments, botRef);
  const known =
    mobileGoatBotKnown(
      environments,
      botRef,
      home.resolution.state === "claimed" ? home.resolution.claim : null,
    ) || advertisedEnvironments.size > 0;
  const mode = effectiveHomeMode(preferences?.homeMode, known);
  const setMode = useCallback(
    (homeMode: "thread" | "bot") => {
      if (loaded) savePreferences({ homeMode });
    },
    [loaded, savePreferences],
  );
  return { mode, known, loaded, botRef, environments, home, setMode };
}

/** Both the compact header and the persistent sidebar return to empty detail. */
export function useMobileGoatBotModeButton() {
  const home = useMobileGoatBotHomeMode();
  const { mode, setMode } = home;
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const threadOpen = useNavigationState(mobileGoatBotDetailOpen);
  const toggle = useCallback(() => {
    const state = navigation.getState();
    const threadOpen = mobileGoatBotDetailOpen(state);
    const homeMode = threadOpen || mode !== "bot" ? "bot" : "thread";
    setMode(homeMode);
    if (homeMode === "bot") {
      if (state.routes.some((route) => route.name === "Home"))
        navigation.dispatch(StackActions.popTo("Home"));
      else navigation.dispatch(StackActions.replace("Home"));
    }
  }, [mode, setMode, navigation]);
  return { ...home, threadOpen, toggle };
}

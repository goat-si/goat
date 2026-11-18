import * as QuickActions from "expo-quick-actions";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useLinkTo, type NavigationState } from "@react-navigation/native";

import {
  loadRecentThreadShortcuts,
  saveRecentThreadShortcuts,
  type RecentThreadShortcut,
} from "../../persistence/imperative";
import { environmentCatalog } from "../../connection/catalog";
import { useThreadShell } from "../../state/entities";
import {
  activeThreadRef,
  buildShortcutActions,
  shortcutHref,
  reconcileRecentThreadShortcuts,
} from "./appShortcuts";

const knownEnvironmentsAtom =
  Platform.OS === "android"
    ? environmentCatalog.catalogValueAtom.pipe(
        Atom.map((catalog) => (catalog.isReady ? new Set<string>(catalog.entries.keys()) : null)),
      )
    : Atom.make<ReadonlySet<string> | null>(null);

export function useAppShortcuts(state: NavigationState): void {
  useShortcutNavigation();
  useRecentThreadShortcutSync(state);
}

function useShortcutNavigation(): void {
  const linkTo = useLinkTo();
  const handledInitialAction = useRef(false);

  useEffect(() => {
    // Handle the launch action before listeners; push over Home so Back returns there.
    if (!handledInitialAction.current) {
      handledInitialAction.current = true;
      const initialHref = QuickActions.initial ? shortcutHref(QuickActions.initial) : null;
      if (initialHref !== null) {
        linkTo(initialHref);
      }
    }

    const subscription = QuickActions.addListener((action) => {
      const href = shortcutHref(action);
      if (href !== null) {
        linkTo(href);
      }
    });
    return () => subscription.remove();
  }, [linkTo]);
}

function useRecentThreadShortcutSync(state: NavigationState): void {
  // iOS subscriptions for Android-only shortcuts would re-render every screen on active-thread updates.
  const threadRef = useMemo(
    () => (Platform.OS === "android" ? activeThreadRef(state) : null),
    [state],
  );
  const threadShell = useThreadShell(threadRef);
  // Wait for persisted recents before recording visits, or cold starts overwrite older entries.
  const [snapshot, setSnapshot] = useState<{
    readonly threads: readonly RecentThreadShortcut[];
    readonly persistable: boolean;
  } | null>(null);
  const knownEnvironments = useAtomValue(knownEnvironmentsAtom);
  // Serialize saves so older lists cannot overwrite newer ones.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    let cancelled = false;
    void loadRecentThreadShortcuts()
      .then((threads) => {
        if (!cancelled) {
          setSnapshot({ threads, persistable: true });
        }
      })
      .catch((error) => {
        console.warn("[app-shortcuts] failed to load recent threads", error);
        if (!cancelled) {
          setSnapshot({ threads: [], persistable: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (snapshot && knownEnvironments) {
    const active = threadRef ? { ...threadRef, title: threadShell?.title ?? "" } : null;
    const threads = reconcileRecentThreadShortcuts(snapshot.threads, active, knownEnvironments);
    if (threads !== snapshot.threads) setSnapshot({ threads, persistable: true });
  }
  const ready = knownEnvironments !== null;
  useEffect(() => {
    if (!snapshot || !ready) return;
    const { threads, persistable } = snapshot;
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      if (persistable) {
        await saveRecentThreadShortcuts(threads).catch((error) => {
          console.warn("[app-shortcuts] failed to persist recent threads", error);
        });
      }
      await QuickActions.setItems(buildShortcutActions(threads)).catch((error) => {
        console.warn("[app-shortcuts] failed to update launcher shortcuts", error);
      });
    });
  }, [snapshot, ready]);
}

import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";

// Surfaces holding unsaved or in-progress work hold back an automatic navigation, such as New bot
// opening the chat it created. They live all over the app, so the holds are a module the navigating
// code reads when it is about to move.
const holds = new Set<symbol>();
// Holds under a surface kept mounted but off screen: unsaved work the person cannot see now.
const pausedHolds = new Set<symbol>();
const pausedListeners = new Set<() => void>();
const notifyPaused = () => {
  for (const listener of pausedListeners) listener();
};

// Any modal popup in the app: dialogs, alert dialogs, sheets and the command palette. Base UI
// drops data-open as soon as one starts to close. The narrow sidebar's sheet renders as
// data-slot="sidebar" and never counts.
const OPEN_MODAL = ["dialog-popup", "alert-dialog-popup", "sheet-popup", "command-dialog-popup"]
  .map((slot) => `[data-slot="${slot}"][data-open]`)
  .join(", ");

function modalOpen(): boolean {
  return document.querySelector(OPEN_MODAL) !== null;
}

/** Holds navigation back until the returned release runs; releasing twice is harmless. */
export function holdNavigation(): () => void {
  const token = Symbol("navigation-hold");
  holds.add(token);
  return () => {
    holds.delete(token);
  };
}

/** True while a hold is taken or anything modal is open, in any part of the app. */
export function navigationBlocked(): boolean {
  return holds.size > 0 || modalOpen();
}

export function resetNavigationHoldsForTests(): void {
  holds.clear();
  pausedHolds.clear();
  notifyPaused();
}

/** True under a surface kept mounted but off screen: the holds inside it pause. */
export const NavigationHoldsPaused = createContext(false);

/** How many holds are paused under a surface off screen: unsaved work the person cannot see. */
export function usePausedNavigationHolds(): number {
  return useSyncExternalStore(
    (listener) => {
      pausedListeners.add(listener);
      return () => pausedListeners.delete(listener);
    },
    () => pausedHolds.size,
  );
}

/** Holds navigation back while mounted and shown; while its surface is off screen, it is counted. */
export function HoldsNavigation(): null {
  const paused = useContext(NavigationHoldsPaused);
  // oxlint-disable-next-line goat/react-effect-budget -- The hold must end with the surface, however it unmounts.
  useLayoutEffect(() => {
    if (!paused) return holdNavigation();
    const token = Symbol("paused-navigation-hold");
    pausedHolds.add(token);
    notifyPaused();
    return () => {
      pausedHolds.delete(token);
      notifyPaused();
    };
  }, [paused]);
  return null;
}

import { useLayoutEffect } from "react";

// Surfaces holding unsaved or in-progress work hold back an automatic navigation, such as New bot
// opening the chat it created. They live all over the app, so the holds are a module the navigating
// code reads when it is about to move.
const holds = new Set<symbol>();

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
}

/** Holds navigation back while mounted; render it inside a surface that mounts only while shown. */
export function HoldsNavigation(): null {
  // oxlint-disable-next-line goat/react-effect-budget -- The hold must end with the surface, however it unmounts.
  useLayoutEffect(() => holdNavigation(), []);
  return null;
}

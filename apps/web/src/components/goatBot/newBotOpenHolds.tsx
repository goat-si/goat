import { useLayoutEffect } from "react";

// Bot menus hold back the chat a New bot create would open when it answers. They live in sibling
// components and outside the roster, so the hold is a module the opener reads at answer time.
const holds = new Set<symbol>();

// Any modal popup in the app: dialogs, alert dialogs, sheets and the command palette. Base UI
// drops data-open as soon as one starts to close. The narrow sidebar's sheet, where the roster
// itself lives, renders as data-slot="sidebar" and never counts.
const OPEN_MODAL = ["dialog-popup", "alert-dialog-popup", "sheet-popup", "command-dialog-popup"]
  .map((slot) => `[data-slot="${slot}"][data-open]`)
  .join(", ");

/** Holds the open until the returned release runs; releasing twice is harmless. */
export function holdNewBotOpen(): () => void {
  const token = Symbol("new-bot-open-hold");
  holds.add(token);
  return () => {
    holds.delete(token);
  };
}

/** True while a hold is taken or anything modal is open, in any part of the app. */
export function newBotOpenBlocked(): boolean {
  return holds.size > 0 || document.querySelector(OPEN_MODAL) !== null;
}

/** Holds the open while mounted; render it inside a popup, which mounts only while open. */
export function HoldsNewBotOpen(): null {
  // oxlint-disable-next-line goat/react-effect-budget -- The hold must end with the popup, however it unmounts.
  useLayoutEffect(() => holdNewBotOpen(), []);
  return null;
}

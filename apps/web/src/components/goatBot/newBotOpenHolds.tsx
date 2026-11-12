import { useLayoutEffect } from "react";

// Roster menus and dialogs, and every GOAT Bot profile dialog, hold back the chat a New bot create
// would open when it answers. They live in sibling components and outside the roster, so the hold
// is a module the opener reads at answer time.
const holds = new Set<symbol>();

/** Holds the open until the returned release runs; releasing twice is harmless. */
export function holdNewBotOpen(): () => void {
  const token = Symbol("new-bot-open-hold");
  holds.add(token);
  return () => {
    holds.delete(token);
  };
}

export function newBotOpenHeld(): boolean {
  return holds.size > 0;
}

/** Holds the open while mounted; render it inside a popup, which mounts only while open. */
export function HoldsNewBotOpen(): null {
  // oxlint-disable-next-line goat/react-effect-budget -- The hold must end with the popup, however it unmounts.
  useLayoutEffect(() => holdNewBotOpen(), []);
  return null;
}

import type { DesktopTrayThread } from "./trayMenu.ts";

export type TrayPick = Pick<DesktopTrayThread, "environmentId" | "threadId">;

export interface TrayPickRenderer {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, pick: TrayPick) => void;
}

/**
 * Holds the latest tray pick until a renderer that listens for it is known. A renderer counts
 * once it publishes a menu, which it does only after subscribing.
 */
export function createTrayPicks<R extends TrayPickRenderer>(channel: string) {
  let renderer: R | null = null;
  let pending: TrayPick | null = null;
  const deliver = () => {
    if (pending === null || renderer === null || renderer.isDestroyed()) return;
    renderer.send(channel, pending);
    pending = null;
  };
  return {
    pick: (pick: TrayPick) => {
      pending = pick;
      deliver();
    },
    listening: (next: R) => {
      renderer = next;
      deliver();
    },
    /** Returns whether `gone` was the listening renderer. */
    gone: (gone: R) => {
      if (renderer !== gone) return false;
      renderer = null;
      return true;
    },
    isListening: (candidate: R) => renderer === candidate,
  };
}

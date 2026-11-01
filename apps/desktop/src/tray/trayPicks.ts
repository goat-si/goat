export interface TrayActionRenderer<A> {
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, action: A) => void;
}

/**
 * Holds the latest tray action until a renderer that listens for it is known. A renderer counts
 * once it publishes a menu, which it does only after subscribing.
 */
export function createTrayPicks<A, R extends TrayActionRenderer<A>>(channel: string) {
  let renderer: R | null = null;
  let pending: A | null = null;
  const deliver = () => {
    if (pending === null || renderer === null || renderer.isDestroyed()) return;
    renderer.send(channel, pending);
    pending = null;
  };
  return {
    pick: (action: A) => {
      pending = action;
      deliver();
    },
    /** Delivers now to the listening renderer, or drops: a stop must not replay later. */
    send: (action: A) => {
      if (renderer !== null && !renderer.isDestroyed()) renderer.send(channel, action);
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

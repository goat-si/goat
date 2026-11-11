import { useState, useSyncExternalStore } from "react";

// For servers that do not track visits: how far the person read each main chat in this app run.
const localReads = new Map<string, string>();
const localReadListeners = new Set<() => void>();
const subscribeLocalReads = (onChange: () => void) => {
  localReadListeners.add(onChange);
  return () => {
    localReadListeners.delete(onChange);
  };
};

/** Records how far the person read a conversation whose server keeps no visits. */
export function recordGoatBotLocalRead(conversation: string, at: string) {
  if (localReads.get(conversation) === at) return;
  localReads.set(conversation, at);
  for (const listener of localReadListeners) listener();
}

/** How far the person read a conversation in this app run, for servers that keep no visits. */
export function useGoatBotLocalRead(conversation: string | null): string | null {
  return useSyncExternalStore(subscribeLocalReads, () =>
    conversation === null ? null : (localReads.get(conversation) ?? null),
  );
}

export interface GoatBotVisitSnapshot {
  /** One focused visit of one conversation. */
  readonly key: string;
  /** When the person last read the chat before this visit; null when they never had. */
  readonly readUpTo: string | null;
  /** The newest message there was when the visit began: later ones are read as they arrive. */
  readonly newestAtOpen: string | null;
}

/**
 * The chat's read position as it stood when this visit began, taken once per focused visit and
 * before the visit is recorded, so recording it cannot move the "New" divider away. Null until the
 * conversation's shell has loaded, and while the chat is not focused.
 */
export function useGoatBotVisitSnapshot(input: {
  /** A visit lasts while the chat is focused and the app is in the foreground. */
  readonly focused: boolean;
  /**
   * The person can see the chat now; false while iOS is inactive (Control Center, the app
   * switcher). Replies that arrive then stay unread, though the visit and its boundary continue.
   */
  readonly reading?: boolean;
  readonly conversation: string | null;
  /** The conversation's shell and messages have loaded; lastVisitedAt may still be null. */
  readonly loaded: boolean;
  readonly lastVisitedAt: string | null;
  readonly newestAt: string | null;
}): GoatBotVisitSnapshot | null {
  const [focus, setFocus] = useState({ focused: false, visit: 0 });
  if (focus.focused !== input.focused) {
    setFocus({ focused: input.focused, visit: focus.visit + (input.focused ? 1 : 0) });
  }
  const key =
    input.focused && focus.focused && input.conversation !== null
      ? `${input.conversation}:${focus.visit}`
      : null;
  const [snapshot, setSnapshot] = useState<GoatBotVisitSnapshot | null>(null);
  if (key !== null && snapshot?.key !== key && input.loaded) {
    setSnapshot({ key, readUpTo: input.lastVisitedAt, newestAtOpen: input.newestAt });
  } else if (
    key !== null &&
    snapshot?.key === key &&
    input.reading === false &&
    snapshot.newestAtOpen !== input.newestAt
  ) {
    setSnapshot({ ...snapshot, newestAtOpen: input.newestAt });
  }
  return key !== null && snapshot?.key === key ? snapshot : null;
}

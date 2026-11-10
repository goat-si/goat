import { useState } from "react";

export interface GoatBotVisitSnapshot {
  /** One focused visit of one conversation. */
  readonly key: string;
  /** When the person last read the chat before this visit; null when they never had. */
  readonly readUpTo: string | null;
}

/**
 * The chat's read position as it stood when this visit began, taken once per focused visit and
 * before the visit is recorded, so recording it cannot move the "New" divider away. Null until the
 * conversation's shell has loaded, and while the chat is not focused.
 */
export function useGoatBotVisitSnapshot(input: {
  readonly focused: boolean;
  readonly conversation: string | null;
  /** The conversation's shell has loaded; its lastVisitedAt may still be null. */
  readonly loaded: boolean;
  readonly lastVisitedAt: string | null;
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
    setSnapshot({ key, readUpTo: input.lastVisitedAt });
  }
  return key !== null && snapshot?.key === key ? snapshot : null;
}

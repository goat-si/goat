import type { EnvironmentId, PreviewSession, ScopedThreadRef } from "@goat/contracts";
import { create } from "zustand";

/**
 * Which session a caller asked the stack to show: by id, by a thread's browser tab, or by kind
 * alone for the first of that kind.
 */
export interface PreviewSessionStackFocus {
  readonly kind: "browser" | "desktop";
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly tabId?: string;
}

export const matchesFocus = (session: PreviewSession, focus: PreviewSessionStackFocus) =>
  focus.sessionId !== undefined
    ? session.id === focus.sessionId
    : focus.tabId !== undefined
      ? session.target.kind === "browser" &&
        session.target.tabId === focus.tabId &&
        (focus.threadId === undefined || session.threadId === focus.threadId)
      : session.kind === focus.kind;

/** Session ids are unique per environment only. */
export const sessionKey = (session: Pick<PreviewSession, "environmentId" | "id">) =>
  `${session.environmentId}|${session.id}`;

/** What a closed card's session is, so a later request to show it can find it. */
interface HiddenSession {
  readonly session: PreviewSession;
}

type ExpandedSession = PreviewSessionStackFocus & { readonly environmentId?: EnvironmentId };

/** Cards belong to one thread, so state about them is kept per environment and thread. */
export const stackThreadKey = (environmentId: string | undefined, threadId: string | undefined) =>
  `${environmentId ?? ""}|${threadId ?? ""}`;

/** sessionStorage belongs to one tab or Electron window and survives its reloads. */
const HIDDEN_KEY = "goat:agent-screen-cards:hidden";

const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

function writeHidden(hidden: boolean) {
  try {
    if (hidden) storage()?.setItem(HIDDEN_KEY, "1");
    else storage()?.removeItem(HIDDEN_KEY);
  } catch {
    // A full or blocked storage only loses the choice across reloads.
  }
}

interface PreviewSessionStackState {
  /** The person hid the cards in this window. */
  readonly hidden: boolean;
  /** The thread pane has no room for a card beside the conversation, so cards hide by themselves. */
  readonly narrow: boolean;
  /** Shown although the pane is narrow, because the person asked for them there. */
  readonly revealedWhileNarrow: boolean;
  /** Stopped sessions whose card the person closed, by sessionKey. */
  readonly dismissed: ReadonlySet<string>;
  /**
   * Sessions whose card the person closed while the agent worked on, by sessionKey. Showing the
   * cards again from the header brings them back, and so does a request to show that session.
   */
  readonly hiddenLive: ReadonlyMap<string, HiddenSession>;
  /** Each thread's session shown at the large size, until it is shrunk, closed or gone. */
  readonly expanded: ReadonlyMap<string, ExpandedSession>;
  /** Threads whose agent asked to show its cards while the person had hidden them. */
  readonly revealedThreads: ReadonlySet<string>;
  readonly focus: PreviewSessionStackFocus | null;
  /** Bumps on each request, so asking for the same session again scrolls to it again. */
  readonly focusRequest: number;
  /** Showing brings back the closed cards of the given thread; other threads keep theirs closed. */
  readonly setShown: (shown: boolean, threadRef?: ScopedThreadRef | null) => void;
  readonly setNarrow: (narrow: boolean) => void;
  readonly dismiss: (session: PreviewSession) => void;
  readonly expand: (session: PreviewSession) => void;
  readonly collapse: (threadKey: string) => void;
}

export const usePreviewSessionStack = create<PreviewSessionStackState>()((set, get) => ({
  hidden: storage()?.getItem(HIDDEN_KEY) === "1",
  narrow: false,
  revealedWhileNarrow: false,
  dismissed: new Set(),
  hiddenLive: new Map(),
  expanded: new Map(),
  revealedThreads: new Set(),
  focus: null,
  focusRequest: 0,
  setShown: (shown, threadRef) => {
    const { narrow, revealedThreads } = get();
    const key = threadRef ? stackThreadKey(threadRef.environmentId, threadRef.threadId) : null;
    const unrevealed =
      key !== null && revealedThreads.has(key)
        ? new Set([...revealedThreads].filter((entry) => entry !== key))
        : revealedThreads;
    // Hiding cards that only a narrow pane let through keeps the window's choice for wide panes.
    if (!shown && narrow) return set({ revealedWhileNarrow: false, revealedThreads: unrevealed });
    writeHidden(!shown);
    set({
      hidden: !shown,
      revealedWhileNarrow: shown && narrow,
      // Hiding is the window's choice, so no thread's agent reveal outlasts it.
      revealedThreads: shown ? unrevealed : new Set(),
      ...(shown
        ? {
            hiddenLive: new Map(
              [...get().hiddenLive].filter(
                ([, { session }]) =>
                  session.environmentId !== threadRef?.environmentId ||
                  session.threadId !== threadRef.threadId,
              ),
            ),
          }
        : {}),
    });
  },
  setNarrow: (narrow) => {
    if (get().narrow !== narrow)
      set({ narrow, revealedWhileNarrow: false, revealedThreads: new Set() });
  },
  dismiss: (session) =>
    set((state) => ({
      ...(session.status === "stopped"
        ? { dismissed: new Set(state.dismissed).add(sessionKey(session)) }
        : { hiddenLive: new Map(state.hiddenLive).set(sessionKey(session), { session }) }),
      expanded: withoutExpanded(
        state.expanded,
        stackThreadKey(session.environmentId, session.threadId),
        session,
      ),
    })),
  expand: (session) =>
    set((state) => ({
      expanded: new Map(state.expanded).set(
        stackThreadKey(session.environmentId, session.threadId),
        { kind: session.kind, sessionId: session.id, environmentId: session.environmentId },
      ),
    })),
  collapse: (threadKey) =>
    set((state) => ({ expanded: withoutExpanded(state.expanded, threadKey) })),
}));

function withoutExpanded(
  expanded: ReadonlyMap<string, ExpandedSession>,
  threadKey: string,
  session?: PreviewSession,
): ReadonlyMap<string, ExpandedSession> {
  const entry = expanded.get(threadKey);
  if (entry === undefined || (session !== undefined && !matchesFocus(session, entry)))
    return expanded;
  const next = new Map(expanded);
  next.delete(threadKey);
  return next;
}

/** Whether the thread on screen shows its cards: the window's choice, or its agent's request. */
export const selectAgentCardsShown =
  (threadKey: string | null) => (state: PreviewSessionStackState) => {
    const revealed = threadKey !== null && state.revealedThreads.has(threadKey);
    return (!state.hidden || revealed) && (!state.narrow || state.revealedWhileNarrow || revealed);
  };

/** A person's request to show a session brings back its card if they had closed it. */
function withoutRevealed(
  hidden: ReadonlyMap<string, HiddenSession>,
  input: { readonly environmentId?: EnvironmentId; readonly focus?: PreviewSessionStackFocus },
): ReadonlyMap<string, HiddenSession> {
  const { focus, environmentId } = input;
  if (focus === undefined) return hidden;
  const kept = new Map(
    [...hidden].filter(
      ([, { session }]) =>
        !(
          (environmentId === undefined || session.environmentId === environmentId) &&
          matchesFocus(session, focus)
        ),
    ),
  );
  return kept.size === hidden.size ? hidden : kept;
}

/**
 * Brings one session's card into view, for example when an agent opens a browser tab; the card
 * keeps the size the person last chose. A person's request also shows hidden cards, even in a
 * narrow pane; an agent's forced one shows them only in its own thread; an automatic one leaves
 * the window's choice alone.
 */
export function openPreviewSessionStack(input?: {
  readonly environmentId?: EnvironmentId;
  readonly focus?: PreviewSessionStackFocus;
  readonly automatic?: boolean;
  readonly scope?: "window" | "thread";
}): void {
  const asked = !input?.automatic;
  const windowWide = asked && input?.scope !== "thread";
  const threadKey = stackThreadKey(input?.environmentId, input?.focus?.threadId);
  if (windowWide) writeHidden(false);
  usePreviewSessionStack.setState((state) => ({
    ...(windowWide ? { hidden: false, revealedWhileNarrow: state.narrow } : {}),
    ...(asked && !windowWide && (state.hidden || state.narrow)
      ? { revealedThreads: new Set(state.revealedThreads).add(threadKey) }
      : {}),
    ...(input?.focus && asked ? { hiddenLive: withoutRevealed(state.hiddenLive, input) } : {}),
    focus: input?.focus ?? null,
    focusRequest: state.focusRequest + 1,
  }));
}

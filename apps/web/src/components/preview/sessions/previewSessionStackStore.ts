import type { EnvironmentId, PreviewSession } from "@goat/contracts";
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
  /** The session shown at the large size, until it is shrunk, closed or gone. */
  readonly expanded: (PreviewSessionStackFocus & { readonly environmentId?: EnvironmentId }) | null;
  readonly focus: PreviewSessionStackFocus | null;
  /** Bumps on each request, so asking for the same session again scrolls to it again. */
  readonly focusRequest: number;
  readonly setShown: (shown: boolean) => void;
  readonly setNarrow: (narrow: boolean) => void;
  readonly dismiss: (session: PreviewSession) => void;
  readonly expand: (session: PreviewSession) => void;
  readonly collapse: () => void;
}

export const usePreviewSessionStack = create<PreviewSessionStackState>()((set, get) => ({
  hidden: storage()?.getItem(HIDDEN_KEY) === "1",
  narrow: false,
  revealedWhileNarrow: false,
  dismissed: new Set(),
  expanded: null,
  focus: null,
  focusRequest: 0,
  setShown: (shown) => {
    const { narrow } = get();
    // Hiding cards that only a narrow pane let through keeps the window's choice for wide panes.
    if (!shown && narrow) return set({ revealedWhileNarrow: false });
    writeHidden(!shown);
    set({ hidden: !shown, revealedWhileNarrow: shown && narrow });
  },
  setNarrow: (narrow) => {
    if (get().narrow !== narrow) set({ narrow, revealedWhileNarrow: false });
  },
  dismiss: (session) =>
    set((state) => ({
      dismissed: new Set(state.dismissed).add(sessionKey(session)),
      expanded: state.expanded?.sessionId === session.id ? null : state.expanded,
    })),
  expand: (session) =>
    set({
      expanded: { kind: session.kind, sessionId: session.id, environmentId: session.environmentId },
    }),
  collapse: () => set({ expanded: null }),
}));

export const selectAgentCardsShown = (state: PreviewSessionStackState) =>
  !state.hidden && (!state.narrow || state.revealedWhileNarrow);

/**
 * Brings one session's card into view, for example when an agent opens a browser tab, and can
 * show it at the large size. A person's request also shows hidden cards, even in a narrow pane;
 * an automatic one leaves the window's choice alone.
 */
export function openPreviewSessionStack(input?: {
  readonly environmentId?: EnvironmentId;
  readonly focus?: PreviewSessionStackFocus;
  readonly expand?: boolean;
  readonly automatic?: boolean;
}): void {
  if (!input?.automatic) writeHidden(false);
  usePreviewSessionStack.setState((state) => ({
    ...(input?.automatic ? {} : { hidden: false, revealedWhileNarrow: state.narrow }),
    focus: input?.focus ?? null,
    focusRequest: state.focusRequest + 1,
    ...(input?.expand && input.focus
      ? {
          expanded: {
            ...input.focus,
            ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
          },
        }
      : {}),
  }));
}

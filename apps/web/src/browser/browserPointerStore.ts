import type {
  AgentCursorSnapshot,
  DesktopPreviewCursorEvent,
  DesktopPreviewCursorStateEvent,
  DesktopPreviewPointerEvent,
} from "@goat/contracts";
import { create } from "zustand";

interface BrowserPointerData {
  readonly byTabId: Record<string, DesktopPreviewPointerEvent>;
  readonly ownerByTabId: Record<string, AgentCursorSnapshot>;
  readonly detached: ReadonlySet<string>;
}

const sameOwner = (a: AgentCursorSnapshot, b: AgentCursorSnapshot) =>
  a.identity.environmentId === b.identity.environmentId &&
  a.identity.runId === b.identity.runId &&
  a.identity.turnId === b.identity.turnId &&
  a.identity.targetId === b.identity.targetId &&
  a.identity.generation === b.identity.generation;

const newer = (previous: AgentCursorSnapshot | undefined, next: AgentCursorSnapshot) =>
  previous === undefined ||
  (sameOwner(previous, next)
    ? next.identity.sequence > previous.identity.sequence &&
      !(
        (previous.phase === "hidden" || previous.phase === "yielded") &&
        next.phase !== "hidden" &&
        next.phase !== "yielded"
      )
    : previous.phase === "hidden" ||
      previous.phase === "yielded" ||
      next.identity.generation > previous.identity.generation);

const isCursorState = (event: DesktopPreviewCursorEvent): event is DesktopPreviewCursorStateEvent =>
  "type" in event && event.type === "cursor-state";

/** Keep a terminal owner as a tombstone so a late previous-run pointer cannot redraw it. */
export function reduceBrowserPointer(
  state: BrowserPointerData,
  event: DesktopPreviewCursorEvent,
): BrowserPointerData {
  if (state.detached.has(event.tabId)) return state;
  const previousOwner = state.ownerByTabId[event.tabId];
  if (isCursorState(event)) {
    if (!newer(previousOwner, event.cursor)) return state;
    const current = state.byTabId[event.tabId];
    const { [event.tabId]: _removed, ...remaining } = state.byTabId;
    const byTabId =
      event.cursor.phase !== "hidden" &&
      event.cursor.phase !== "yielded" &&
      current?.cursor !== undefined &&
      sameOwner(current.cursor, event.cursor)
        ? { ...state.byTabId, [event.tabId]: { ...current, cursor: event.cursor } }
        : remaining;
    return {
      ...state,
      byTabId,
      ownerByTabId: { ...state.ownerByTabId, [event.tabId]: event.cursor },
    };
  }
  if (event.cursor !== undefined) {
    if (!newer(previousOwner, event.cursor)) return state;
    if (event.cursor.phase === "hidden" || event.cursor.phase === "yielded") {
      const { [event.tabId]: _removed, ...byTabId } = state.byTabId;
      return {
        ...state,
        byTabId,
        ownerByTabId: { ...state.ownerByTabId, [event.tabId]: event.cursor },
      };
    }
    return {
      ...state,
      byTabId: { ...state.byTabId, [event.tabId]: event },
      ownerByTabId: { ...state.ownerByTabId, [event.tabId]: event.cursor },
    };
  }
  if (previousOwner !== undefined) return state;
  const previous = state.byTabId[event.tabId];
  if (previous !== undefined && event.sequence <= previous.sequence) return state;
  return { ...state, byTabId: { ...state.byTabId, [event.tabId]: event } };
}

interface BrowserPointerStoreState extends BrowserPointerData {
  readonly apply: (event: DesktopPreviewCursorEvent) => void;
  readonly clear: (tabId: string) => void;
  readonly attach: (tabId: string) => void;
}

export const useBrowserPointerStore = create<BrowserPointerStoreState>()((set) => ({
  byTabId: {},
  ownerByTabId: {},
  detached: new Set(),
  apply: (event) => set((state) => reduceBrowserPointer(state, event)),
  clear: (tabId) =>
    set((state) => {
      const { [tabId]: _removed, ...byTabId } = state.byTabId;
      return { byTabId, detached: new Set(state.detached).add(tabId) };
    }),
  attach: (tabId) =>
    set((state) => {
      if (!state.detached.has(tabId)) return state;
      const detached = new Set(state.detached);
      detached.delete(tabId);
      return { detached };
    }),
}));

import type {
  AgentCursorSnapshot,
  DesktopPreviewCursorEvent,
  DesktopPreviewCursorStateEvent,
  DesktopPreviewPointerEvent,
} from "@goat/contracts";

/** Which agent owns each tab's cursor, and the closed tabs whose late events are ignored. */
export interface BrowserPointerOwners {
  readonly ownerByTabId: Record<string, AgentCursorSnapshot>;
  readonly detached: ReadonlySet<string>;
}

interface BrowserPointerData extends BrowserPointerOwners {
  readonly byTabId: Record<string, DesktopPreviewPointerEvent>;
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

// Closed tabs stay tombstoned so a late event cannot redraw them; the oldest fall off first.
const MAX_DETACHED_TABS = 256;

/** Navigation removes the drawn point; the tab keeps its owner and draws the next pointer. */
export function clearBrowserPointer(state: BrowserPointerData, tabId: string): BrowserPointerData {
  if (!(tabId in state.byTabId)) return state;
  const { [tabId]: _removed, ...byTabId } = state.byTabId;
  return { ...state, byTabId };
}

/** A closed tab drops its point and owner, and ignores every later event until it is attached. */
export function detachBrowserPointer(state: BrowserPointerData, tabId: string): BrowserPointerData {
  const { [tabId]: _point, ...byTabId } = state.byTabId;
  const { [tabId]: _owner, ...ownerByTabId } = state.ownerByTabId;
  const detached = new Set(state.detached);
  detached.delete(tabId);
  detached.add(tabId);
  for (const oldest of detached) {
    if (detached.size <= MAX_DETACHED_TABS) break;
    detached.delete(oldest);
  }
  return { byTabId, ownerByTabId, detached };
}

export function attachBrowserPointer(state: BrowserPointerData, tabId: string): BrowserPointerData {
  if (!state.detached.has(tabId)) return state;
  const detached = new Set(state.detached);
  detached.delete(tabId);
  return { ...state, detached };
}

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
    if (
      !newer(previousOwner, event.cursor) &&
      !(
        previousOwner !== undefined &&
        sameOwner(previousOwner, event.cursor) &&
        previousOwner.identity.sequence === event.cursor.identity.sequence &&
        previousOwner.phase === event.cursor.phase &&
        previousOwner.phase !== "hidden" &&
        previousOwner.phase !== "yielded"
      )
    )
      return state;
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
  if (
    previousOwner !== undefined &&
    previousOwner.phase !== "hidden" &&
    previousOwner.phase !== "yielded"
  )
    return state;
  const previous = state.byTabId[event.tabId];
  if (previous !== undefined && event.sequence <= previous.sequence) return state;
  return { ...state, byTabId: { ...state.byTabId, [event.tabId]: event } };
}

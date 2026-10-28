import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type AgentCursorSnapshot,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ServerBrowserViewerOutput } from "./ServerBrowser.ts";
import type { DispatchGate } from "./ServerBrowserPage.ts";
import {
  BrowserControlInterrupted,
  type HandBackNotice,
  type HandoffChange,
  type SessionControl,
} from "./SessionControl.ts";

/** The parts of a server browser tab that screen runs check and draw on. */
export interface ScreenTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly control: SessionControl;
  readonly page: { readonly url: () => string };
  /** Moves on every main-frame navigation; absent on tabs that do not count them. */
  readonly documentGeneration?: number;
  readonly desktop: object | null;
  readonly viewers: ReadonlySet<{ readonly push: (output: ServerBrowserViewerOutput) => void }>;
}

/** A change in who may drive a tab, reported so screen runs bound to it can stop. */
export interface AuthorityChange {
  readonly kind: "stop" | "private" | "takeover" | "handBack";
  readonly reason?: "tabClosed";
  readonly threadId: string;
  readonly tabId: string;
}
export type AuthorityListener = (change: AuthorityChange) => void;

/** Who controls a tab, as one viewer hears it. */
export const viewerControl = (control: SessionControl, viewerId: string) => ({
  controller:
    control.controller === viewerId
      ? ("you" as const)
      : control.controller !== null
        ? ("another-viewer" as const)
        : control.agentId !== null
          ? ("agent" as const)
          : ("unclaimed" as const),
  generation: control.generation,
  private: control.isPrivate,
  // An agent asked a person for a step here and waits for them to hand the tab back.
  waitingForPerson: control.handoffReason !== null,
  ...(control.handBackNotice === null ? {} : { handBackNotice: control.handBackNotice }),
});

/** A person took, handed back or ended an agent's request on a tab. */
export interface HandoffChanged {
  readonly threadId: string;
  readonly tabId: string;
  readonly change: HandoffChange;
  /** The request the person ended; a newer one on the same tab is not settled by it. */
  readonly requestId: string;
}

/** What the screen surface adds to ServerBrowser; optional so test doubles can leave it out. */
export interface SurfaceService {
  readonly onAuthorityChange?: (listener: AuthorityListener) => () => void;
  readonly cursorState?: CursorStateSink;
  /** Holds an agent tab for a person; false when the tab is gone, a person's or stopped. */
  readonly requestHandoff?: (input: {
    readonly threadId: string;
    readonly tabId: string;
    readonly reason: string;
    readonly requestId: string;
  }) => Effect.Effect<boolean>;
  /** Ends a tab's request because its record ended; no HandoffChanged is reported. */
  readonly endHandoff?: (input: {
    readonly threadId: string;
    readonly tabId: string;
  }) => Effect.Effect<void>;
  readonly onHandoffChange?: (listener: (changed: HandoffChanged) => void) => () => void;
  /** Tells a tab's viewers why a person's hand back did not complete the request. */
  readonly noteHandBack?: (input: {
    readonly threadId: string;
    readonly tabId: string;
    readonly notice: HandBackNotice;
  }) => Effect.Effect<void>;
}

/** The trusted screen host supplies the exact tab after claim admission. */
export type CursorStateSink = (input: {
  readonly threadId: string;
  readonly tabId: string;
  readonly cursor: AgentCursorSnapshot;
}) => Effect.Effect<boolean>;

/** Reports only real control changes: generation moves, not every viewer or owner update. */
export const authorityReporter = (
  tab: Pick<ScreenTab, "control" | "threadId" | "tabId">,
  notify: AuthorityListener,
) => {
  let observedGeneration = tab.control.generation;
  return () => {
    if (tab.control.generation === observedGeneration) return;
    observedGeneration = tab.control.generation;
    notify({
      // Closing drops the owner too; that ends the tab, it does not hand it back.
      kind: tab.control.isClosed
        ? "stop"
        : tab.control.isPrivate
          ? "private"
          : tab.control.isAgentStopped
            ? "stop"
            : tab.control.controller !== null || tab.control.handoffReason !== null
              ? "takeover"
              : "handBack",
      threadId: tab.threadId,
      tabId: tab.tabId,
      ...(tab.control.isClosed ? { reason: "tabClosed" as const } : {}),
    });
  };
};

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
};

/** A screen run acts only on the exact tab, control generation and origin it observed. */
export const assertScreenExpectation = (tab: ScreenTab, request: PreviewAutomationRequest) => {
  const expected = request.screenExpectation;
  if (!expected) return;
  if (
    !request.tabIdExplicit ||
    request.tabId !== tab.tabId ||
    expected.browserInstanceId !== SERVER_BROWSER_AUTOMATION_CLIENT_ID
  )
    throw new BrowserControlInterrupted("Exact browser tab changed.");
  tab.control.assertObservedGeneration(expected.controlGeneration);
  if (originOf(tab.page.url()) !== expected.origin)
    throw new BrowserControlInterrupted("Page origin changed; bind and observe again.");
  if (
    expected.documentGeneration !== undefined &&
    tab.documentGeneration !== expected.documentGeneration
  )
    throw new BrowserControlInterrupted("The page changed since that screenshot; observe again.");
};

/** Passes a read's result through once the tab still matches what the screen run observed. */
export const recheck =
  (tab: ScreenTab | undefined, request: PreviewAutomationRequest) =>
  <A>(result: A): A => {
    if (tab) assertScreenExpectation(tab, request);
    return result;
  };

/** Checks the screen expectation on both sides of a read; a missing tab reads unchecked. */
export const checkedAround = async <Tab extends ScreenTab | undefined, A>(
  tab: Tab,
  request: PreviewAutomationRequest,
  read: (tab: Tab) => Promise<A>,
): Promise<A> => {
  if (tab) assertScreenExpectation(tab, request);
  return read(tab).then(recheck(tab, request));
};

export const assertScreenConnection = (request: PreviewAutomationRequest, connectionId: string) => {
  const expected = request.screenExpectation;
  if (
    expected &&
    (expected.connectionId !== connectionId ||
      expected.browserInstanceId !== SERVER_BROWSER_AUTOMATION_CLIENT_ID)
  )
    throw new BrowserControlInterrupted("Exact browser connection changed.");
};

/** A secret field has focus: closing now would throw away what the person is typing. */
export const refusePrivateClose = (tab: ScreenTab) => {
  if (tab.control.isPrivate)
    throw new BrowserControlInterrupted("A private field has focus in this tab.", "privateMode");
};

/** Call when the action starts; the gate rechecks the screen expectation right before input lands. */
export const screenActionGate = (
  tab: ScreenTab,
  request: PreviewAutomationRequest,
): DispatchGate => {
  const base = tab.control.dispatchGate(request.screenExpectation?.controlGeneration);
  return Object.assign(
    () => {
      assertScreenExpectation(tab, request);
      base();
    },
    base.linger ? { linger: base.linger } : {},
  );
};

/**
 * Shows the agent cursor to the tab's viewers. A visible cursor needs an agent in control;
 * hiding or yielding always goes through so a stale cursor never lingers.
 */
const pushCursorState = (
  tab: ScreenTab,
  cursor: AgentCursorSnapshot,
  pushDesktop: (cursor: AgentCursorSnapshot) => void,
): boolean => {
  const terminal = cursor.phase === "hidden" || cursor.phase === "yielded";
  if (
    !terminal &&
    (tab.control.agentId === null || tab.control.isPrivate || tab.control.controller !== null)
  )
    return false;
  for (const viewer of tab.viewers) viewer.push({ _tag: "cursor-state", cursor });
  if (tab.desktop) pushDesktop(cursor);
  return true;
};

/** Keep pointer order at least as fresh as the last cursor state delivered to this tab. */
export const nextPointerSequence = (previous: number, cursor?: AgentCursorSnapshot): number =>
  Math.max(previous + 1, cursor?.identity.sequence ?? 0);

/** The agent pointer as the desktop host and a recording take it. */
export interface AgentPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly cursor?: AgentCursorSnapshot;
}

/** The screen state one ServerBrowser keeps: authority listeners and each tab's last cursor. */
export const makeSurface = <Tab extends ScreenTab>(
  findTab: (threadId: string, tabId: string) => Tab | undefined,
  pushDesktop: (
    key: { readonly threadId: string; readonly tabId: string },
    cursor: AgentCursorSnapshot,
  ) => void,
  /** Draws a pointer outside the viewers: the desktop host and a recording. */
  drawPointer: (tab: Tab, pointer: AgentPointer) => void = () => {},
) => {
  const listeners = new Set<AuthorityListener>();
  const handoffListeners = new Set<(changed: HandoffChanged) => void>();
  const watched = new WeakSet<Tab>();
  const cursorByTab = new WeakMap<Tab, AgentCursorSnapshot>();
  /** Where the agent's pointer last was on each tab, and on which document. */
  const pointerByTab = new WeakMap<Tab, { x: number; y: number; document?: number }>();
  let pointerSequence = 0;
  const notify: AuthorityListener = (change) => {
    for (const listener of listeners) listener(change);
  };
  const onAuthorityChange = (listener: AuthorityListener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const notePointer = (tab: Tab, x: number, y: number) =>
    void pointerByTab.set(tab, {
      x,
      y,
      ...(tab.documentGeneration === undefined ? {} : { document: tab.documentGeneration }),
    });
  /** The visible cursor that owns the tab's pointer now, and the pointer's next sequence. */
  const pointerOwner = (tab: Tab) => {
    const current = cursorByTab.get(tab);
    const cursor =
      current?.phase === "hidden" || current?.phase === "yielded" ? undefined : current;
    pointerSequence = nextPointerSequence(pointerSequence, current);
    return { sequence: pointerSequence, withCursor: cursor ? { cursor } : {} };
  };
  /** Draws the agent's pointer for the tab's viewers, with the visible cursor that owns it. */
  const showPointer = (tab: Tab, x: number, y: number, phase: "move" | "click") => {
    const { sequence, withCursor } = pointerOwner(tab);
    for (const viewer of tab.viewers)
      viewer.push({ _tag: "pointer", phase, x, y, sequence, ...withCursor });
    drawPointer(tab, { phase, x, y, ...withCursor });
    notePointer(tab, x, y);
  };
  const replayed = new WeakSet<object>();
  /**
   * After a viewer's first frame, it sees where the agent's owned pointer last was on this page.
   * A viewer places a pointer by its viewport and frame, so an earlier replay would be misplaced.
   */
  const framed = (
    tab: Tab,
    viewer: ScreenTab["viewers"] extends ReadonlySet<infer V> ? V : never,
  ) => {
    if (replayed.has(viewer)) return;
    replayed.add(viewer);
    const last = pointerByTab.get(tab);
    if (last === undefined || last.document !== tab.documentGeneration) return;
    const { sequence, withCursor } = pointerOwner(tab);
    if ("cursor" in withCursor)
      viewer.push({
        _tag: "pointer",
        phase: "move",
        x: last.x,
        y: last.y,
        sequence,
        ...withCursor,
      });
  };
  const cursorState: CursorStateSink = (input) =>
    Effect.sync(() => {
      const tab = findTab(input.threadId, input.tabId);
      if (!tab) return false;
      const key = { threadId: tab.threadId, tabId: tab.tabId };
      const sent = pushCursorState(tab, input.cursor, (cursor) => pushDesktop(key, cursor));
      if (sent) cursorByTab.set(tab, input.cursor);
      // Each state carries the agent's position: the last pointer on this document, redrawn
      // under the new state, so a state that arrives after its action's pointer cannot drop it.
      const last = pointerByTab.get(tab);
      if (
        sent &&
        last !== undefined &&
        last.document === tab.documentGeneration &&
        input.cursor.phase !== "hidden" &&
        input.cursor.phase !== "yielded"
      )
        showPointer(tab, last.x, last.y, "move");
      return sent;
    });
  const requestHandoff: NonNullable<SurfaceService["requestHandoff"]> = (input) =>
    Effect.sync(() => {
      const tab = findTab(input.threadId, input.tabId);
      if (!tab || tab.control.agentId === null) return false;
      if (!watched.has(tab)) {
        watched.add(tab);
        tab.control.onHandoffChange((change, requestId) => {
          for (const listener of handoffListeners)
            listener({ threadId: tab.threadId, tabId: tab.tabId, change, requestId });
        });
      }
      return tab.control.requestHandoff(input.reason, input.requestId);
    });
  const endHandoff: NonNullable<SurfaceService["endHandoff"]> = (input) =>
    Effect.sync(() => findTab(input.threadId, input.tabId)?.control.endHandoff(null));
  const noteHandBack: NonNullable<SurfaceService["noteHandBack"]> = (input) =>
    Effect.sync(() => findTab(input.threadId, input.tabId)?.control.noteHandBack(input.notice));
  const onHandoffChange = (listener: (changed: HandoffChanged) => void) => {
    handoffListeners.add(listener);
    return () => void handoffListeners.delete(listener);
  };
  return {
    notify,
    showPointer,
    notePointer,
    framed,
    service: {
      onAuthorityChange,
      cursorState,
      requestHandoff,
      endHandoff,
      onHandoffChange,
      noteHandBack,
    },
  };
};

type Size = { readonly width: number; readonly height: number };

/** Where a full-page capture sits in the document, so screen code can map its pixels back. */
export const documentPlacement = (width: number, height: number, imageWidth: number) => ({
  region: { kind: "document" as const, x: 0, y: 0, width, height },
  scale: imageWidth / width,
});

/** A viewport capture's size with its placement; points map to viewport coordinates. */
export const viewportPlacement = (viewport: Size, image: Size) => ({
  ...image,
  region: {
    kind: "viewport" as const,
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  },
  scale: image.width / viewport.width,
});

/**
 * Cuts the masked tree and namespaces its refs. Screen code learns whether the cut or a frame the
 * tree could not read left part of the page out.
 */
export const screenTree = (
  text: string,
  input: {
    readonly limit: number;
    readonly unread: ReadonlyArray<unknown>;
    readonly generation: string;
    readonly refs: Map<string, string>;
  },
) => {
  const { generation } = input;
  return {
    accessibilityTree: text
      .slice(0, input.limit)
      .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
        const ref = `t3-${generation}-${nativeRef}`;
        input.refs.set(ref, nativeRef);
        return `[ref=${ref}]`;
      }),
    treeComplete: text.length <= input.limit && input.unread.length === 0,
    refGeneration: String(generation),
  };
};

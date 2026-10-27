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
  type HandoffEnd,
  type SessionControl,
} from "./SessionControl.ts";

/** The parts of a server browser tab that screen runs check and draw on. */
export interface ScreenTab {
  readonly threadId: string;
  readonly tabId: string;
  readonly control: SessionControl;
  readonly page: { readonly url: () => string };
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

/** A person ended an agent's request on a tab. */
export interface HandoffEnded {
  readonly threadId: string;
  readonly tabId: string;
  readonly end: HandoffEnd;
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
  /** Ends a tab's request because its record ended; no HandoffEnded is reported. */
  readonly endHandoff?: (input: {
    readonly threadId: string;
    readonly tabId: string;
  }) => Effect.Effect<void>;
  readonly onHandoffEnd?: (listener: (ended: HandoffEnded) => void) => () => void;
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

/** The screen state one ServerBrowser keeps: authority listeners and each tab's last cursor. */
export const makeSurface = <Tab extends ScreenTab>(
  findTab: (threadId: string, tabId: string) => Tab | undefined,
  pushDesktop: (
    key: { readonly threadId: string; readonly tabId: string },
    cursor: AgentCursorSnapshot,
  ) => void,
) => {
  const listeners = new Set<AuthorityListener>();
  const handoffListeners = new Set<(ended: HandoffEnded) => void>();
  const watched = new WeakSet<Tab>();
  const cursorByTab = new WeakMap<Tab, AgentCursorSnapshot>();
  const notify: AuthorityListener = (change) => {
    for (const listener of listeners) listener(change);
  };
  const onAuthorityChange = (listener: AuthorityListener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  /** The next pointer sequence, and the visible cursor to draw the pointer with. */
  const nextPointer = (tab: Tab, previous: number) => {
    const current = cursorByTab.get(tab);
    const cursor =
      current?.phase === "hidden" || current?.phase === "yielded" ? undefined : current;
    return {
      sequence: nextPointerSequence(previous, current),
      withCursor: cursor ? { cursor } : {},
    };
  };
  const cursorState: CursorStateSink = (input) =>
    Effect.sync(() => {
      const tab = findTab(input.threadId, input.tabId);
      if (!tab) return false;
      const key = { threadId: tab.threadId, tabId: tab.tabId };
      const sent = pushCursorState(tab, input.cursor, (cursor) => pushDesktop(key, cursor));
      if (sent) cursorByTab.set(tab, input.cursor);
      return sent;
    });
  const requestHandoff: NonNullable<SurfaceService["requestHandoff"]> = (input) =>
    Effect.sync(() => {
      const tab = findTab(input.threadId, input.tabId);
      if (!tab || tab.control.agentId === null) return false;
      if (!watched.has(tab)) {
        watched.add(tab);
        tab.control.onHandoffEnd((end, requestId) => {
          for (const listener of handoffListeners)
            listener({ threadId: tab.threadId, tabId: tab.tabId, end, requestId });
        });
      }
      return tab.control.requestHandoff(input.reason, input.requestId);
    });
  const endHandoff: NonNullable<SurfaceService["endHandoff"]> = (input) =>
    Effect.sync(() => findTab(input.threadId, input.tabId)?.control.endHandoff(null));
  const onHandoffEnd = (listener: (ended: HandoffEnded) => void) => {
    handoffListeners.add(listener);
    return () => void handoffListeners.delete(listener);
  };
  return {
    notify,
    nextPointer,
    service: { onAuthorityChange, cursorState, requestHandoff, endHandoff, onHandoffEnd },
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

import {
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type AgentCursorSnapshot,
  type PreviewAutomationRequest,
} from "@goat/contracts";

import type { DispatchGate } from "./ServerBrowserPage.ts";
import type { ServerTab } from "./ServerBrowserTypes.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

/** A change in who may drive a tab, reported so screen runs bound to it can stop. */
export interface AuthorityChange {
  readonly kind: "stop" | "private" | "takeover" | "handBack";
  readonly threadId: string;
  readonly tabId: string;
}
export type AuthorityListener = (change: AuthorityChange) => void;

/** Reports only real control changes: generation moves, not every viewer or owner update. */
export const authorityReporter = (tab: ServerTab, notify: AuthorityListener) => {
  let observedGeneration = tab.control.generation;
  return () => {
    if (tab.control.generation === observedGeneration) return;
    observedGeneration = tab.control.generation;
    notify({
      kind: tab.control.isPrivate
        ? "private"
        : tab.control.isAgentStopped
          ? "stop"
          : tab.control.controller !== null
            ? "takeover"
            : "handBack",
      threadId: tab.threadId,
      tabId: tab.tabId,
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
export const assertScreenExpectation = (tab: ServerTab, request: PreviewAutomationRequest) => {
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

export const assertScreenConnection = (request: PreviewAutomationRequest, connectionId: string) => {
  const expected = request.screenExpectation;
  if (
    expected &&
    (expected.connectionId !== connectionId ||
      expected.browserInstanceId !== SERVER_BROWSER_AUTOMATION_CLIENT_ID)
  )
    throw new BrowserControlInterrupted("Exact browser connection changed.");
};

/** Call when the action starts; the gate rechecks the screen expectation right before input lands. */
export const screenActionGate = (
  tab: ServerTab,
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
export const pushCursorState = (
  tab: ServerTab,
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

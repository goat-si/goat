import type { PreviewAutomationRequest } from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";
import { makeActionChannel } from "./actionChannel.ts";
import type { DispatchGate } from "./ServerBrowserPage.ts";
import * as ServerBrowserScreen from "./ServerBrowserScreen.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

interface Tab extends ServerBrowserScreen.ScreenTab {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly closing: boolean;
}
interface Fence {
  readonly assertTab: (tab: Tab, runId: string | undefined, url?: string) => Promise<void>;
  readonly gate: (tab: Tab, runId: string | undefined, base: DispatchGate) => DispatchGate;
  readonly isFenced: (tab: Tab, runId: string | undefined) => boolean;
  readonly blockedFrame: (tab: Tab, runId: string | undefined, destination?: string) => boolean;
  readonly signal: (tab: Tab, runId: string | undefined) => AbortSignal | undefined;
}

export const tabActionGate = (
  tab: Tab,
  request: PreviewAutomationRequest,
  fence: Fence,
  deadline: number,
  signal?: AbortSignal,
  destination?: string,
  observe = false,
) => {
  if (!signal) throw new BrowserControlInterrupted("The agent action has no cancellation signal.");
  const runSignal = fence.signal(tab, request.runId);
  const latchedSignal = runSignal ? AbortSignal.any([signal, runSignal]) : signal;
  const generation = tab.control.generation;
  const base = ServerBrowserScreen.screenActionGate(tab, request);
  const channel = makeActionChannel({
    cdp: tab.cdp,
    page: tab.page,
    signal: latchedSignal,
    controlGeneration: () => {
      ServerBrowserScreen.assertScreenExpectation(tab, request);
      if (!observe) tab.control.assertAgentMayDispatch();
      tab.control.assertObservedGeneration(generation);
    },
    isFenced: () => fence.isFenced(tab, request.runId),
    blockedFrame: () => fence.blockedFrame(tab, request.runId, destination),
  });
  return Object.assign(fence.gate(tab, request.runId, base), {
    deadline,
    signal: latchedSignal,
    channel,
  });
};

export const secretBlockedGate = (
  tab: Tab,
  runId: string | undefined,
  fence: Fence,
  signal?: AbortSignal,
) =>
  Object.assign((destination: string) => fence.assertTab(tab, runId, destination), {
    signal,
    isFenced: () => fence.isFenced(tab, runId),
    blockedFrame: () => fence.blockedFrame(tab, runId),
  });

export const initialTabChannel = (
  tab: Tab,
  fence: Fence,
  runId: string | undefined,
  destination: string,
  signal?: AbortSignal,
) => {
  const generation = tab.control.generation;
  return makeActionChannel({
    page: tab.page,
    cdp: tab.cdp,
    signal: signal ?? new AbortController().signal,
    controlGeneration: () => {
      tab.control.assertAgentMayDispatch();
      tab.control.assertObservedGeneration(generation);
    },
    isFenced: () => fence.isFenced(tab, runId),
    blockedFrame: () => fence.blockedFrame(tab, runId, destination),
  });
};

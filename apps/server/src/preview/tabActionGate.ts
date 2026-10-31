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
}

export const tabActionGate = (
  tab: Tab,
  request: PreviewAutomationRequest,
  fence: Fence,
  deadline: number,
  signal?: AbortSignal,
  destination?: string,
) => {
  if (!signal) throw new BrowserControlInterrupted("The agent action has no cancellation signal.");
  const generation = tab.control.generation;
  const base = ServerBrowserScreen.screenActionGate(tab, request);
  const channel = makeActionChannel({
    cdp: tab.cdp,
    page: tab.page,
    signal,
    controlGeneration: () => {
      ServerBrowserScreen.assertScreenExpectation(tab, request);
      tab.control.assertAgentMayDispatch();
      tab.control.assertObservedGeneration(generation);
    },
    isFenced: () => fence.isFenced(tab, request.runId),
    blockedFrame: () => fence.blockedFrame(tab, request.runId, destination),
  });
  return Object.assign(fence.gate(tab, request.runId, base), { deadline, signal, channel });
};

export const secretBlockedGate = (tab: Tab, runId: string | undefined, fence: Fence) =>
  Object.assign((destination: string) => fence.assertTab(tab, runId, destination), {
    isFenced: () => fence.isFenced(tab, runId),
    blockedFrame: () => fence.blockedFrame(tab, runId),
  });

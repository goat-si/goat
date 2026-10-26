import type { PreviewAutomationReloadInput } from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted, type SessionControl } from "./SessionControl.ts";

/**
 * Back, forward and reload run only while the agent keeps control: once control changes, the
 * call fails wherever the page landed, before and after the status read.
 */
export const guardedHistoryNavigation = async <
  Tab extends { readonly page: Page; readonly cdp: CDPSession; readonly control: SessionControl },
  Status,
>(input: {
  readonly tab: Tab;
  readonly operation: "back" | "forward" | "reload";
  readonly agentSessionId: string;
  readonly reload: PreviewAutomationReloadInput;
  readonly timeoutMs: number;
  readonly recordAction: <A>(tab: Tab, action: string, run: () => Promise<A>) => Promise<A>;
  readonly status: (tab: Tab) => Promise<Status>;
}): Promise<Status> => {
  const { tab, operation } = input;
  const generation = tab.control.generation;
  const assertControl = () => {
    if (generation !== tab.control.generation || !tab.control.agentCanActNow(input.agentSessionId))
      throw new BrowserControlInterrupted(
        "Browser control changed during navigation. The page may have navigated; refresh the snapshot before trying again.",
      );
  };
  try {
    await input.recordAction(tab, operation, () =>
      ServerBrowserPage.navigateHistory(
        tab.page,
        tab.cdp,
        operation,
        input.reload,
        input.timeoutMs,
        assertControl,
      ),
    );
    assertControl();
    const status = await input.status(tab);
    assertControl();
    return status;
  } catch (cause) {
    assertControl();
    throw cause;
  }
};

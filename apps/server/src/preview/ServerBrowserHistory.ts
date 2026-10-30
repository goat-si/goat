import type { PreviewAutomationReloadInput } from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted, type SessionControl } from "./SessionControl.ts";

/** Real Chromium history, including same-document entries whose response is null. */
const navigateHistory = async (
  page: Page,
  cdp: CDPSession,
  operation: "back" | "forward" | "reload",
  input: PreviewAutomationReloadInput,
  timeout: number,
  assertControl: () => void,
  assertDestination: (url?: string) => Promise<void>,
) => {
  const options = {
    timeout: input.timeoutMs ?? timeout,
    waitUntil:
      input.readiness === "domContentLoaded" ? ("domcontentloaded" as const) : ("load" as const),
  };
  if (operation === "reload" && input.ignoreCache !== true) {
    await assertDestination();
    assertControl();
    ServerBrowserPage.invalidateRefs(page);
    await page.reload(options);
    return;
  }
  let dispatch = () => cdp.send("Page.reload", { ignoreCache: true });
  if (operation !== "reload") {
    const history = await cdp.send("Page.getNavigationHistory");
    const index = history.currentIndex + (operation === "back" ? -1 : 1);
    const entry = history.entries[index];
    if (entry?.id === undefined) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `No ${operation} history entry exists for this browser tab.`,
      );
    }
    const entryId = entry.id;
    dispatch = () => cdp.send("Page.navigateToHistoryEntry", { entryId });
    await assertDestination(entry.url);
  }
  await assertDestination();
  assertControl();
  ServerBrowserPage.invalidateRefs(page);
  // Install the waiter before sending CDP: an acknowledgement alone does not
  // prove that Electron's guest page actually committed a navigation.
  await Promise.all([page.waitForNavigation(options), dispatch()]);
};

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
  readonly assertDestination: (url?: string) => Promise<void>;
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
      navigateHistory(
        tab.page,
        tab.cdp,
        operation,
        input.reload,
        input.timeoutMs,
        assertControl,
        input.assertDestination,
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

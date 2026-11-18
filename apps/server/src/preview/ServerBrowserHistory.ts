import { stopUnresponsiveScript } from "./stopUnresponsiveScript.ts";
import type { PreviewAutomationReloadInput } from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import type { ActionChannel } from "./actionChannel.ts";
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
  channelFor: (destination?: string) => ActionChannel,
  canProbe: () => boolean,
) => {
  const options = {
    timeout: input.timeoutMs ?? timeout,
    waitUntil:
      input.readiness === "domContentLoaded" ? ("domcontentloaded" as const) : ("load" as const),
  };
  const leave = async (channel: ActionChannel) => {
    const startedAt = performance.now();
    await stopUnresponsiveScript(channel, canProbe, options.timeout / 2);
    options.timeout = Math.max(1, options.timeout - (performance.now() - startedAt));
    assertControl();
  };
  if (operation === "reload" && input.ignoreCache !== true) {
    await assertDestination();
    assertControl();
    ServerBrowserPage.invalidateRefs(page);
    const channel = channelFor();
    await leave(channel);
    await channel.call(() => page.reload(options));
    return;
  }
  let destination: string | undefined;
  let dispatch = () => channelFor().send("Page.reload", { ignoreCache: true });
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
    destination = entry.url;
    const entryId = entry.id;
    dispatch = () => channelFor(entry.url).send("Page.navigateToHistoryEntry", { entryId });
    await assertDestination(entry.url);
  }
  await assertDestination();
  assertControl();
  ServerBrowserPage.invalidateRefs(page);
  await leave(channelFor(destination));
  // Install the waiter before sending CDP: an acknowledgement alone does not
  // prove that Electron's guest page actually committed a navigation.
  const waiting = page.waitForNavigation(options);
  try {
    await Promise.all([waiting, dispatch()]);
  } catch (cause) {
    void waiting.catch(() => undefined);
    throw cause;
  }
};

/**
 * Back, forward and reload run only while the agent keeps control: once control changes, the
 * call fails wherever the page landed, before and after the status read.
 */
export const guardedHistoryNavigation = async <
  Tab extends {
    readonly page: Page;
    readonly cdp: CDPSession;
    readonly control: SessionControl;
    pendingInitialRequestUrl?: string | null;
    readonly dialog?: unknown;
    readonly crash?: { readonly url: string } | undefined;
  },
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
  readonly channelFor: (destination?: string) => ActionChannel;
}): Promise<Status> => {
  const { tab, operation } = input;
  // A stopped first load to the same URL must not swallow this navigation's request.
  tab.pendingInitialRequestUrl = null;
  const generation = tab.control.generation;
  const assertControl = () => {
    if (generation !== tab.control.generation || !tab.control.agentCanActNow(input.agentSessionId))
      throw new BrowserControlInterrupted(
        "Browser control changed during navigation. The page may have navigated; refresh the snapshot before trying again.",
      );
  };
  try {
    await input.recordAction(tab, operation, async () => {
      if (operation === "reload" && tab.crash) {
        const url = tab.crash.url;
        await input.assertDestination(url);
        assertControl();
        await input.channelFor(url).call(() =>
          tab.page.goto(url, {
            timeout: input.reload.timeoutMs ?? input.timeoutMs,
            waitUntil: input.reload.readiness === "domContentLoaded" ? "domcontentloaded" : "load",
          }),
        );
        return;
      }
      return navigateHistory(
        tab.page,
        tab.cdp,
        operation,
        input.reload,
        input.timeoutMs,
        assertControl,
        input.assertDestination,
        input.channelFor,
        () => !tab.dialog,
      );
    });
    assertControl();
    const status = await input.status(tab);
    assertControl();
    return status;
  } catch (cause) {
    assertControl();
    throw cause;
  }
};

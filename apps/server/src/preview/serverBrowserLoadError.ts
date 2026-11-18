import type { PreviewAutomationLoadError } from "@goat/contracts";
import { constVoid } from "effect/Function";
import type { Page } from "playwright-core";

import { ServerBrowserOperationError } from "./browserOperationError.ts";
import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

type LoadErrorTab = Parameters<typeof loadErrorOf>[0];

/** Why the tab shows Chromium's error page, or undefined when it shows a page. */
export const loadErrorOf = (
  tab: {
    readonly threadId: string;
    readonly tabId: string;
    readonly page: { url(): string };
    readonly loadError: PreviewAutomationLoadError | undefined;
    readonly desktop: unknown;
    readonly navigationGeneration: number;
  },
  desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
): PreviewAutomationLoadError | undefined => {
  if (!tab.page.url().startsWith("chrome-error://")) return undefined;
  // A desktop failure from before CDP attached is superseded by any navigation we observe.
  if (tab.loadError || !tab.desktop || tab.navigationGeneration > 0) return tab.loadError;
  const reported = desktopChannel.loadFailure?.({ threadId: tab.threadId, tabId: tab.tabId });
  return reported && { ...reported, url: ServerBrowserPage.withoutDataPayload(reported.url) };
};

/** The URL a tab list names: none for a blank tab, and the failed page over Chromium's error page. */
export const reportedTabUrl = (
  tab: LoadErrorTab,
  desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
): string | null =>
  tab.page.url() === "about:blank"
    ? null
    : (loadErrorOf(tab, desktopChannel)?.url ??
      ServerBrowserPage.withoutDataPayload(tab.page.url()));

/**
 * Throws when a navigation ended on Chromium's error page, naming the page without its
 * credentials, query or fragment. A new tab stays open and is named, like any open whose page
 * never connected.
 */
export const assertNavigationSucceeded = (
  tab: LoadErrorTab,
  desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
  openedTabId?: string,
): void => {
  const failure = loadErrorOf(tab, desktopChannel);
  if (!failure) return;
  const parsed = URL.parse(failure.url);
  if (parsed) {
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
  }
  const url = parsed ? ServerBrowserPage.withoutDataPayload(parsed.href) : "the requested page";
  const message = `Navigation to ${url} failed: ${failure.description}`;
  throw openedTabId === undefined
    ? new ServerBrowserOperationError("PreviewAutomationExecutionError", message, {
        ...failure,
        url,
      })
    : new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `${message}; its new tab ${openedTabId} is still open.`,
        { url, openedTabId, loadError: failure.description },
      );
};

/** Waits for a new tab's first page, then fails when it shows Chromium's error page. */
export const assertOpenedPageLoaded = async (
  tab: LoadErrorTab & { readonly page: Pick<Page, "url" | "waitForLoadState"> },
  desktopChannel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
  timeout: number,
): Promise<void> => {
  await tab.page.waitForLoadState("load", { timeout }).catch(constVoid);
  assertNavigationSucceeded(tab, desktopChannel, tab.tabId);
};

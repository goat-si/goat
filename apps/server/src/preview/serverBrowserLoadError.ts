import type { PreviewAutomationLoadError } from "@goat/contracts";

import type * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

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

/**
 * Stop on a loading tab. Chromium can answer Page.stopLoading without a Playwright load or
 * requestfailed event, so the tab settles its own status.
 */
import type { CDPSession } from "playwright-core";

export interface StoppableTab {
  readonly page: { url(): string };
  loading: boolean;
  navigationGeneration: number;
  /** The navigation Stop cancelled; its aborted request is the stop, not a download. */
  stoppedGeneration: number | null;
  /** The first load's URL until its request event arrives, which can come after Stop. */
  pendingInitialRequestUrl: string | null;
}

/** The URL a first load's request event carries: Chromium drops the fragment. */
export const initialRequestUrl = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed) parsed.hash = "";
  return parsed?.href ?? null;
};

/** Whether a main-frame request is the first load Stop already ended; it is then no longer pending. */
export const stoppedFirstRequest = (tab: StoppableTab, url: string) => {
  const stopped =
    url === tab.pendingInitialRequestUrl && tab.stoppedGeneration === tab.navigationGeneration;
  tab.pendingInitialRequestUrl = null;
  return stopped;
};

export const makeStopLoading = <Tab extends StoppableTab>(settled: (tab: Tab) => void) => {
  const settle = (tab: Tab, generation: number) => {
    if (tab.navigationGeneration !== generation || !tab.loading) return;
    tab.loading = false;
    settled(tab);
  };
  const stop = async (tab: Tab, session: Pick<CDPSession, "send">) => {
    const generation = tab.navigationGeneration;
    tab.stoppedGeneration = generation;
    await session.send("Page.stopLoading");
    settle(tab, generation);
  };
  return { settle, stop };
};

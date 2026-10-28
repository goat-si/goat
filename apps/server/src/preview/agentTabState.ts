/**
 * Small decisions about an agent's server browser tab that the tab state alone settles: who a
 * popup belongs to, and the size a desktop-rendered page really has.
 *
 * @module agentTabState
 */
import type { PreviewViewportSetting } from "@goat/contracts";
import type { CDPSession } from "playwright-core";

/** How long after an agent's input a popup still counts as opened by it. */
export const POPUP_ATTRIBUTION_MS = 2_000;

export interface AgentInput {
  readonly agentId: string;
  readonly at: number;
}

/**
 * The agent a popup opens for: the opener's owner, else the agent whose input is running on the
 * opener or ended moments ago, so it can use and close what its click opened.
 */
export const popupOwner = (
  opener: {
    readonly control: { readonly agentId: string | null };
    readonly agentOperating: boolean;
    readonly lastAgentInput?: AgentInput | undefined;
  },
  now: number,
): string | null => {
  if (opener.control.agentId !== null) return opener.control.agentId;
  const recent = opener.lastAgentInput;
  return recent && (opener.agentOperating || now - recent.at < POPUP_ATTRIBUTION_MS)
    ? recent.agentId
    : null;
};

type Size = { readonly width: number; readonly height: number };

/** A desktop page's CSS layout viewport, which Playwright's viewportSize() does not know. */
export const renderedViewport = async (cdp: Pick<CDPSession, "send">, fallback: Size) => {
  const { cssLayoutViewport } = await cdp.send("Page.getLayoutMetrics");
  return cssLayoutViewport
    ? { width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight }
    : fallback;
};

/** Applies a viewport setting and reports the size the page then has, with fill's caveat. */
export const measuredResize = async (
  tab: {
    readonly desktop: object | null;
    readonly cdp: Pick<CDPSession, "send">;
    readonly page: { viewportSize(): Size | null };
  },
  fallback: Size,
  apply: () => Promise<void>,
) => {
  const before = tab.desktop ? await renderedViewport(tab.cdp, fallback) : undefined;
  await apply();
  const viewport = tab.desktop
    ? await renderedViewport(tab.cdp, fallback)
    : (tab.page.viewportSize() ?? fallback);
  return (setting: PreviewViewportSetting) => ({
    viewport,
    ...fillNote(setting, before, viewport),
  });
};

/** The desktop sizes a filled tab to the panel showing it; with none, the size stays. */
export const fillNote = (setting: PreviewViewportSetting, before: Size | undefined, after: Size) =>
  setting._tag === "fill" && before?.width === after.width && before.height === after.height
    ? {
        next: `Fill follows the panel that shows this tab; if no panel shows it, it keeps ${after.width}x${after.height}. Show it (goat_preview_open show:true) or set a freeform size.`,
      }
    : {};

/** Refusing an implicit target among several tabs names them, so the switch stays explicit. */
export const tabChoice = (
  owned: ReadonlyArray<{ readonly tabId: string; readonly openerTabId: string | undefined }>,
) =>
  `This agent session has several tabs: ${owned
    .map((tab) => (tab.openerTabId ? `${tab.tabId} (popup of ${tab.openerTabId})` : tab.tabId))
    .join(", ")}. Pass tabId to choose one; the current tab does not change on its own.`;

const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

/**
 * Popups that closed, by thread and tab, so a call aimed at one learns where its opener is.
 * `live` holds the open tabs under the same thread-and-tab key.
 */
export class ClosedPopups {
  private readonly openers = new Map<string, string>();
  constructor(private readonly limit = 64) {}
  record(threadId: string, tabId: string, openerTabId: string) {
    this.openers.set(keyOf(threadId, tabId), openerTabId);
    if (this.openers.size > this.limit) this.openers.delete(this.openers.keys().next().value ?? "");
  }
  note(threadId: string, tabId: string, live: { has(key: string): boolean }) {
    const opener = this.openers.get(keyOf(threadId, tabId));
    if (opener === undefined) return undefined;
    return live.has(keyOf(threadId, opener))
      ? `Tab ${tabId}, a popup, has closed. Its opener ${opener} is still open: pass tabId ${opener} to continue there.`
      : `Tab ${tabId}, a popup, has closed and its opener ${opener} is gone too. Choose a tab from goat_preview_status.`;
  }
}

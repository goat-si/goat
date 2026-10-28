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
    readonly ownerId: string | null;
    readonly agentOperating: boolean;
    readonly lastAgentInput?: AgentInput | undefined;
  },
  now: number,
): string | null => {
  if (opener.ownerId !== null) return opener.ownerId;
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

/** The desktop sizes a filled tab to the panel showing it; with none, the size stays. */
export const fillNote = (setting: PreviewViewportSetting, before: Size | undefined, after: Size) =>
  setting._tag === "fill" && before?.width === after.width && before.height === after.height
    ? {
        next: `Fill follows the panel that shows this tab; if no panel shows it, it keeps ${after.width}x${after.height}. Show it (goat_preview_open show:true) or set a freeform size.`,
      }
    : {};

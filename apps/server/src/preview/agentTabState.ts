/**
 * Small decisions about an agent's server browser tab that the tab state alone settles: who a
 * popup belongs to, and the size a desktop-rendered page really has.
 *
 * @module agentTabState
 */
import { closedPopupMessage, type PreviewViewportSetting } from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

/** How long after an agent's input a popup still counts as opened by it. */
export const POPUP_ATTRIBUTION_MS = 2_000;

export interface AgentInput {
  readonly agentId: string;
  readonly at: number;
  /** The tab's control generation then; a person taking the tab since moves it on. */
  readonly generation: number;
}

/**
 * The agent a popup opens for: the opener's owner, else the agent whose input is running on the
 * opener or ended moments ago, so it can use and close what its click opened. Once a person has
 * taken the tab since, the popup is theirs.
 */
export const popupOwner = (
  opener: {
    readonly control: { readonly agentId: string | null; readonly generation: number };
    readonly agentOperating: boolean;
    readonly lastAgentInput?: AgentInput | undefined;
  },
  now: number,
): string | null => {
  if (opener.control.agentId !== null) return opener.control.agentId;
  const recent = opener.lastAgentInput;
  return recent &&
    recent.generation === opener.control.generation &&
    (opener.agentOperating || now - recent.at < POPUP_ATTRIBUTION_MS)
    ? recent.agentId
    : null;
};

/** Openings remembered per tab; the oldest goes first once a tab opens more windows than this. */
const OPENINGS_KEPT = 32;

type Opener = Omit<Parameters<typeof popupOwner>[0], "lastAgentInput">;

/**
 * Who a tab's popups belong to. Playwright reports a popup only after its first response, when
 * another agent may have acted on the opener, so the owner is decided when the window is created
 * and looked up by its CDP target id when the popup arrives, in whatever order they arrive.
 */
export class PopupAttribution {
  /** The agent whose input last reached the tab. */
  lastInput: AgentInput | undefined;
  private readonly openings = new Map<string, string | null>();

  opened(targetId: string, opener: Opener, now: number) {
    this.openings.set(targetId, popupOwner({ ...opener, lastAgentInput: this.lastInput }, now));
    if (this.openings.size > OPENINGS_KEPT)
      this.openings.delete(this.openings.keys().next().value ?? "");
  }

  owner(targetId: string | undefined, opener: Opener, now: number) {
    const opening = targetId === undefined ? undefined : this.openings.get(targetId);
    if (opening === undefined)
      return popupOwner({ ...opener, lastAgentInput: this.lastInput }, now);
    this.openings.delete(targetId ?? "");
    return opening;
  }
}

/** Records each window the tab's page opens, as Chromium creates it, before any later input. */
export const watchOpenings = async (
  cdp: Pick<CDPSession, "send" | "on">,
  tab: Opener & { readonly popups: PopupAttribution },
) => {
  const self = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
  cdp.on("Target.targetCreated", ({ targetInfo }) => {
    if (targetInfo.openerId === self) tab.popups.opened(targetInfo.targetId, tab, Date.now());
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
};

/** A popup page's CDP target id, which its opening was recorded under. */
export const targetIdOf = async (popup: Page) => {
  const session = await popup.context().newCDPSession(popup);
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId;
  } finally {
    void session.detach().catch(() => undefined);
  }
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
  private readonly limit: number;
  constructor(limit = 64) {
    this.limit = limit;
  }
  record(threadId: string, tabId: string, openerTabId: string) {
    this.openers.set(keyOf(threadId, tabId), openerTabId);
    if (this.openers.size > this.limit) this.openers.delete(this.openers.keys().next().value ?? "");
  }
  /** Why a call found no tab: a closed popup names its opener, in a field the broker carries. */
  notFound(threadId: string, tabId: string | undefined, live: { has(key: string): boolean }) {
    const opener = tabId === undefined ? undefined : this.openers.get(keyOf(threadId, tabId));
    if (tabId === undefined || opener === undefined)
      return new ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        'No server preview tab is open for this thread. Call goat_call {path:"preview.open"} first.',
      );
    const closedPopup = { openerTabId: opener, openerOpen: live.has(keyOf(threadId, opener)) };
    return new ServerBrowserOperationError(
      "PreviewAutomationTabNotFoundError",
      closedPopupMessage(tabId, closedPopup),
      { closedPopup },
    );
  }
}

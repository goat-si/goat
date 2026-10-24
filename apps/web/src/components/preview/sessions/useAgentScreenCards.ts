import { orderPreviewSessions } from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId, PreviewSession, ScopedThreadRef } from "@goat/contracts";
import { type RefObject, useEffect, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { toastManager } from "~/components/ui/toast";
import { previewSessionsEnvironment, usePreviewSessions } from "~/state/previewSessions";
import { useAtomCommand } from "~/state/use-atom-command";

import { sessionKey, usePreviewSessionStack } from "./previewSessionStackStore";

/** Aside's card width; browser and desktop cards share it. */
export const AGENT_CARD_WIDTH_PX = 240;
/** The floating mini player's edge gap, so a card and the player line up. */
const AGENT_CARD_GAP_PX = 12;
/** Below the header when no chat header is on screen (`top-14`). */
const FALLBACK_TOP_PX = 56;
/** Something on the column this close below the cards' top leaves no room for a card above it. */
const MIN_CARD_SPACE_PX = 160;
/**
 * Every card's picture is 16:10: the server browser opens pages at 1280x800, and Mac displays,
 * where desktop apps run, are 16:10. Any page or window letterboxes inside it.
 */
const AGENT_VIEW_ASPECT = 16 / 10;
/** The card's padding and one-line header around its picture, in px. */
const CARD_CHROME = { width: 12, height: 40 } as const;
const LARGE_MAX_WIDTH_PX = 720;
/** The large view takes up to this share of the pane, so the conversation stays in sight. */
const LARGE_PANE_SHARE = 0.5;

/**
 * Whether a card fits in the gutter right of the conversation column. Cards overlay the pane, so
 * when one would cover the conversation they hide instead of moving it.
 */
function agentCardFits(paneWidth: number, contentWidth: number) {
  const gutter = (paneWidth - Math.min(contentWidth, paneWidth)) / 2;
  return gutter >= AGENT_CARD_WIDTH_PX + 2 * AGENT_CARD_GAP_PX;
}

/** The card's height for a width; the picture keeps its aspect at every size. */
const agentCardHeight = (width: number) =>
  CARD_CHROME.height + (width - CARD_CHROME.width) / AGENT_VIEW_ASPECT;

/**
 * The large view's width: it follows the pane's width, capped so the whole card fits the height
 * it has. Only its frame changes size; the page inside keeps its own viewport.
 */
function largeAgentViewWidth(paneWidth: number, maxHeight: number) {
  const byHeight = (maxHeight - CARD_CHROME.height) * AGENT_VIEW_ASPECT + CARD_CHROME.width;
  return Math.round(
    Math.max(
      AGENT_CARD_WIDTH_PX,
      Math.min(LARGE_MAX_WIDTH_PX, paneWidth * LARGE_PANE_SHARE, byHeight),
    ),
  );
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface AgentCardsPlacement {
  readonly top: number;
  readonly right: number;
  readonly maxHeight: number;
}

/**
 * A column of `width` at the pane's right edge, starting under the thread header where the
 * floating mini player does. Something already in that column (the pinned thread details card,
 * the mini player) comes first and the column follows it, or, further down, the column ends above.
 */
function placeAgentColumn(input: {
  readonly pane: Box;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly width: number;
  readonly obstacles: ReadonlyArray<Box>;
}): AgentCardsPlacement {
  const { pane, viewport, width } = input;
  let top = pane.top + AGENT_CARD_GAP_PX;
  let bottom = viewport.height - AGENT_CARD_GAP_PX;
  const columnRight = pane.right - AGENT_CARD_GAP_PX;
  const columnLeft = columnRight - width;
  for (const obstacle of [...input.obstacles].toSorted((a, b) => a.top - b.top)) {
    if (!(obstacle.right > columnLeft && obstacle.left < columnRight)) continue;
    if (obstacle.top - top < MIN_CARD_SPACE_PX)
      top = Math.max(top, obstacle.bottom + AGENT_CARD_GAP_PX);
    else bottom = Math.min(bottom, obstacle.top - AGENT_CARD_GAP_PX);
  }
  return {
    top,
    right: viewport.width - columnRight,
    maxHeight: Math.max(0, bottom - top),
  };
}

export interface AgentScreenLayout {
  readonly card: AgentCardsPlacement;
  /** Null when the large view cannot fit its 16:10 picture; the session then stays a card. */
  readonly large: (AgentCardsPlacement & { readonly width: number }) | null;
}

const OBSTACLES = ["[data-thread-details-card]", "[data-preview-mini-player]"] as const;

/** Lays out cards and the large view for a pane, a viewport, and what already floats there. */
function layoutAgentScreen(input: {
  readonly pane: Box;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly obstacles: ReadonlyArray<Box>;
}): AgentScreenLayout {
  const paneWidth = input.pane.right - input.pane.left;
  const card = placeAgentColumn({ ...input, width: AGENT_CARD_WIDTH_PX });
  const roomy = largeAgentViewWidth(paneWidth, input.viewport.height - input.pane.top);
  const placed = placeAgentColumn({ ...input, width: roomy });
  const width = largeAgentViewWidth(paneWidth, placed.maxHeight);
  const fits =
    agentCardHeight(width) <= placed.maxHeight && width <= paneWidth - 2 * AGENT_CARD_GAP_PX;
  return { card, large: fits ? { ...placed, width } : null };
}

const sameLayout = (a: AgentScreenLayout | null, b: AgentScreenLayout) =>
  a !== null &&
  a.card.top === b.card.top &&
  a.card.right === b.card.right &&
  a.card.maxHeight === b.card.maxHeight &&
  a.large?.top === b.large?.top &&
  a.large?.width === b.large?.width &&
  a.large?.maxHeight === b.large?.maxHeight;

/**
 * Measures the thread pane under `[data-chat-header]` and the conversation width that `probe`
 * resolves from `--chat-content-max-width`, and records whether the pane is too narrow for
 * cards. It runs only while there are cards (`active`). `layoutKey` names a change that moves
 * what floats beside the cards without resizing anything, such as the details panel opening.
 */
export function useAgentCardsPlacement(
  probe: RefObject<HTMLElement | null>,
  layoutKey: string,
  active: boolean,
): AgentScreenLayout | null {
  const setNarrow = usePreviewSessionStack((state) => state.setNarrow);
  const [layout, setLayout] = useState<AgentScreenLayout | null>(null);
  useEffect(() => {
    if (!active) return;
    const elements = () => ({
      header: document.querySelector<HTMLElement>("[data-chat-header]"),
      obstacles: OBSTACLES.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)),
      ),
    });
    const measure = () => {
      const { header, obstacles } = elements();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = header?.getBoundingClientRect();
      const pane = rect
        ? { left: rect.left, right: rect.right, top: rect.bottom, bottom: viewport.height }
        : { left: 0, right: viewport.width, top: FALLBACK_TOP_PX, bottom: viewport.height };
      setNarrow(!agentCardFits(pane.right - pane.left, probe.current?.offsetWidth ?? 0));
      const next = layoutAgentScreen({
        pane,
        viewport,
        obstacles: obstacles.map((element) => element.getBoundingClientRect()),
      });
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    const watched = new Set<Element>();
    const stops: Array<() => void> = [];
    let present: ReadonlyArray<Element> = [];
    // Each element is watched once: resizing moves the column, and a floating view also moves by
    // its style (a drag, the composer growing).
    const watch = () => {
      const { header, obstacles } = elements();
      present = header ? [header, ...obstacles] : obstacles;
      for (const element of present) {
        if (watched.has(element)) continue;
        watched.add(element);
        stops.push(observeResize(element, measure));
        if (element === header) continue;
        const moves = new MutationObserver(measure);
        moves.observe(element, { attributes: true, attributeFilter: ["style"] });
        stops.push(() => moves.disconnect());
      }
    };
    let frame = 0;
    // The header and what floats beside the cards mount with the thread view, and a wider pane
    // pins the details card, often after the change that caused it. Added and removed nodes are
    // checked once a frame, and only a different set of those elements is measured again.
    const tree = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { header, obstacles } = elements();
        const now = header ? [header, ...obstacles] : obstacles;
        if (now.length === present.length && now.every((element, i) => element === present[i]))
          return;
        watch();
        measure();
      });
    });
    tree.observe(document.body, { childList: true, subtree: true });
    watch();
    measure();
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      tree.disconnect();
      for (const stop of stops) stop();
      window.removeEventListener("resize", measure);
    };
  }, [
    active,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new layoutKey moves what floats beside the cards without resizing anything, so it measures again.
    layoutKey,
    probe,
    setNarrow,
  ]);
  return layout;
}

/**
 * One desktop card per thread: a thread's live session (waiting or blocked ones rank first in
 * orderPreviewSessions) stands for it, and a stopped one shows only when nothing newer runs.
 */
function onePerThread(sessions: ReadonlyArray<PreviewSession>) {
  const seen = new Set<string>();
  return [
    ...sessions.filter((session) => session.status !== "stopped"),
    ...sessions.filter((session) => session.status === "stopped"),
  ]
    .filter((session) => {
      if (session.kind !== "desktop" || session.threadId === undefined) return true;
      const key = `${session.environmentId}|${session.threadId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .toSorted((a, b) => sessions.indexOf(a) - sessions.indexOf(b));
}

/**
 * The sessions that get a card: every agent-driven browser tab and desktop session on the
 * environment's host, waiting ones first, one per thread for the desktop, minus the tab the
 * thread's mini player already shows and stopped sessions whose card the person closed.
 */
export function useAgentScreenSessions(
  environmentId: EnvironmentId | null,
  threadRef: ScopedThreadRef | null,
) {
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    threadRef ? selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef) : null,
  );
  const shownTab = miniPlayer?.source.kind === "browser" ? miniPlayer.source.tabId : null;
  const dismissed = usePreviewSessionStack((state) => state.dismissed);
  const sessions = usePreviewSessions(environmentId);
  const threadId = threadRef?.threadId;
  return onePerThread(orderPreviewSessions(sessions)).filter(
    (session) =>
      !(session.status === "stopped" && dismissed.has(sessionKey(session))) &&
      !(
        shownTab !== null &&
        session.threadId === threadId &&
        session.target.kind === "browser" &&
        session.target.tabId === shownTab
      ),
  );
}

/**
 * Stop all, from the header or the cards: every agent on this host's screen and browser tabs
 * stops now. A stop the server could not finish (a grant it could not end) says so.
 */
export function useStopAllAgents(environmentId: EnvironmentId | null) {
  const control = useAtomCommand(previewSessionsEnvironment.control);
  return async () => {
    if (environmentId === null) return;
    const result = await control({ environmentId, input: { control: "stopAll" } });
    // A failed call is reported by the command itself.
    if (result._tag !== "Success" || result.value.applied) return;
    toastManager.add({
      type: "error",
      title: "Some agents could not be stopped",
      description: "An approval for computer use is still active. Try Stop all again.",
    });
  };
}

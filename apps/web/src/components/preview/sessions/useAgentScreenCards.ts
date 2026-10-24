import { orderPreviewSessions } from "@goat/client-runtime/state/preview-sessions";
import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { type RefObject, useEffect, useMemo, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { usePreviewSessions } from "~/state/previewSessions";

import { usePreviewSessionStack } from "./previewSessionStackStore";

/** Aside's card width; browser and desktop cards share it. */
export const AGENT_CARD_WIDTH_PX = 240;
/** The floating mini player's edge gap, so a card and the player line up. */
export const AGENT_CARD_GAP_PX = 12;
/** Below the header when no chat header is on screen (`top-14`). */
const FALLBACK_TOP_PX = 56;
/** A mini player starting this close below the cards' top leaves no room for a card above it. */
const MIN_CARD_SPACE_PX = 160;

/**
 * Whether a card fits in the gutter right of the conversation column. Cards overlay the pane, so
 * when one would cover the conversation they hide instead of moving it.
 */
export function agentCardFits(paneWidth: number, contentWidth: number) {
  const gutter = (paneWidth - Math.min(contentWidth, paneWidth)) / 2;
  return gutter >= AGENT_CARD_WIDTH_PX + 2 * AGENT_CARD_GAP_PX;
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
 * Cards start where the floating mini player does: under the thread header, at the pane's right
 * edge. A mini player in that column comes first and the cards follow it, or, when the person
 * moved it further down, the cards end above it.
 */
export function placeAgentCards(input: {
  readonly pane: Box;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly player: Box | null;
}): AgentCardsPlacement {
  const { pane, viewport, player } = input;
  let top = pane.top + AGENT_CARD_GAP_PX;
  let bottom = viewport.height - AGENT_CARD_GAP_PX;
  const columnRight = pane.right - AGENT_CARD_GAP_PX;
  const columnLeft = columnRight - AGENT_CARD_WIDTH_PX;
  if (player && player.right > columnLeft && player.left < columnRight) {
    if (player.top - top < MIN_CARD_SPACE_PX)
      top = Math.max(top, player.bottom + AGENT_CARD_GAP_PX);
    else bottom = Math.min(bottom, player.top - AGENT_CARD_GAP_PX);
  }
  return {
    top,
    right: viewport.width - columnRight,
    maxHeight: Math.max(0, bottom - top),
  };
}

const samePlacement = (a: AgentCardsPlacement | null, b: AgentCardsPlacement) =>
  a !== null && a.top === b.top && a.right === b.right && a.maxHeight === b.maxHeight;

/**
 * Measures the thread pane under `[data-chat-header]` and the conversation width that `probe`
 * resolves from `--chat-content-max-width`, and records whether the pane is too narrow for
 * cards. `layoutKey` names what replaces the header or the mini player, such as another thread.
 */
export function useAgentCardsPlacement(
  probe: RefObject<HTMLElement | null>,
  layoutKey: string,
): AgentCardsPlacement | null {
  const setNarrow = usePreviewSessionStack((state) => state.setNarrow);
  const [placement, setPlacement] = useState<AgentCardsPlacement | null>(null);
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("[data-chat-header]");
    let player = document.querySelector<HTMLElement>("[data-preview-mini-player]");
    const measure = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = header?.getBoundingClientRect();
      const pane = rect
        ? { left: rect.left, right: rect.right, top: rect.bottom, bottom: viewport.height }
        : { left: 0, right: viewport.width, top: FALLBACK_TOP_PX, bottom: viewport.height };
      setNarrow(!agentCardFits(pane.right - pane.left, probe.current?.offsetWidth ?? 0));
      const next = placeAgentCards({
        pane,
        viewport,
        player: player?.isConnected ? player.getBoundingClientRect() : null,
      });
      setPlacement((current) => (samePlacement(current, next) ? current : next));
    };
    const stops: Array<() => void> = [];
    // The player moves by its style (a drag, the composer growing) as well as by resizing.
    const watchPlayer = (element: HTMLElement) => {
      stops.push(observeResize(element, measure));
      const moves = new MutationObserver(measure);
      moves.observe(element, { attributes: true, attributeFilter: ["style"] });
      stops.push(() => moves.disconnect());
    };
    if (player) watchPlayer(player);
    // The player sizes itself after mounting, so it can appear a frame after this effect.
    const retry = player
      ? null
      : requestAnimationFrame(() => {
          player = document.querySelector<HTMLElement>("[data-preview-mini-player]");
          if (player) watchPlayer(player);
          measure();
        });
    if (header) stops.push(observeResize(header, measure));
    else measure();
    window.addEventListener("resize", measure);
    return () => {
      if (retry !== null) cancelAnimationFrame(retry);
      for (const stop of stops) stop();
      window.removeEventListener("resize", measure);
    };
  }, [layoutKey, probe, setNarrow]);
  return placement;
}

/**
 * The sessions that get a card: every agent-driven browser tab and desktop session on the
 * environment's host, waiting ones first, minus the tab the thread's mini player already shows
 * and stopped sessions whose card the person closed.
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
  return useMemo(
    () =>
      orderPreviewSessions(sessions).filter(
        (session) =>
          !(session.status === "stopped" && dismissed.has(session.id)) &&
          !(
            shownTab !== null &&
            session.threadId === threadId &&
            session.target.kind === "browser" &&
            session.target.tabId === shownTab
          ),
      ),
    [sessions, dismissed, shownTab, threadId],
  );
}

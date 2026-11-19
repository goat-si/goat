import type { ScopedThreadRef } from "@goat/contracts";
import { useEffect, useEffectEvent } from "react";

import { useRightPanelStore } from "~/rightPanelStore";

type PullRequestSelection = Parameters<
  ReturnType<typeof useRightPanelStore.getState>["openPullRequest"]
>[1];

/** The pull request panel props that show a surface's pending link and settle it once shown. */
export const pullRequestLinkRevealProps = (
  panelRef: ScopedThreadRef | null,
  surface: { readonly id: string; readonly revealUrl?: string | undefined },
) => ({
  revealUrl: surface.revealUrl,
  onRevealSettled: (revealUrl: string) => {
    if (panelRef === null) return;
    useRightPanelStore.getState().settlePullRequestReveal(panelRef, surface.id, revealUrl);
  },
});

/**
 * Opens the pull request the page URL names in the right panel. A URL that carried a link is
 * consumed once handed to the panel through the page's search update, which leaves the link out,
 * so a reload does not reveal it again.
 */
export function useLinkedPullRequest(
  panelRef: ScopedThreadRef | null,
  selection: PullRequestSelection | null,
  updateSearch: (patch: Record<never, never>) => void,
) {
  const consume = useEffectEvent(() => updateSearch({}));
  // oxlint-disable-next-line goat/react-effect-budget -- opens the URL-linked pull request in the right panel store
  useEffect(() => {
    if (panelRef === null || selection === null) return;
    useRightPanelStore.getState().openPullRequest(panelRef, selection);
    if (selection.revealUrl !== undefined) consume();
  }, [selection, panelRef]);
}

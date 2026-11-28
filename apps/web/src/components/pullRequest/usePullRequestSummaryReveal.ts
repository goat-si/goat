import { parsePullRequestAnchor } from "@goat/shared/pullRequestAnchor";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { holdLinkedNodeInView, holdScrollTop } from "./holdLinkedNodeInView";

/**
 * Scrolls the Summary tab to a clicked link's section, description or heading once it renders,
 * opens the section it names, and reports the link shown.
 */
export function usePullRequestSummaryReveal(input: {
  readonly revealUrl: string | undefined;
  readonly onRevealSettled: ((revealUrl: string) => void) | undefined;
  readonly description: string;
  readonly editingDescription: boolean;
  readonly initialScrollTop: number;
}) {
  const { revealUrl, onRevealSettled, description, editingDescription, initialScrollTop } = input;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const location = parsePullRequestAnchor(revealUrl);
  const [checksReveals, setChecksReveals] = useState(0);
  const [descriptionReveals, setDescriptionReveals] = useState(0);
  const [seenRevealUrl, setSeenRevealUrl] = useState<string | undefined>(undefined);
  if (revealUrl !== seenRevealUrl) {
    setSeenRevealUrl(revealUrl);
    if (location?.kind === "checks") setChecksReveals((count) => count + 1);
    if (location?.kind === "summary" && location.anchor !== "top") {
      setDescriptionReveals((count) => count + 1);
    }
  }
  const stopHolding = useRef<(() => void) | null>(null);
  // A restore clamped by content still loading must not overwrite the saved position.
  const restoringScroll = useRef(false);
  const revealSummary = useEffectEvent(() => {
    const root = scrollRef.current;
    if (revealUrl === undefined || !root) return;
    let target: HTMLElement | null | undefined;
    if (location?.kind === "checks") {
      target = root.querySelector<HTMLElement>(
        '[data-pull-request-summary-section][aria-label="Checks"]',
      );
    } else if (location?.kind === "summary") {
      if (location.anchor === "top") {
        stopHolding.current?.();
        root.scrollTop = 0;
        return onRevealSettled?.(revealUrl);
      }
      target = /^issue-\d+$/.test(location.anchor)
        ? root.querySelector<HTMLElement>("[data-pr-description]")
        : [...root.querySelectorAll<HTMLElement>("[id]")].find(
            (node) => node.id === location.anchor || node.id === `user-content-${location.anchor}`,
          );
    }
    // A heading may still be rendering; the link stays pending until it appears.
    if (!target) return;
    stopHolding.current?.();
    const heading = target.hasAttribute("data-pull-request-summary-section")
      ? null
      : target.closest("[data-pull-request-summary-section]")?.firstElementChild;
    stopHolding.current = holdLinkedNodeInView(
      target,
      root,
      () => (heading?.getBoundingClientRect().height ?? 0) + (heading ? 8 : 0),
    );
    onRevealSettled?.(revealUrl);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- scrolls to a linked section, description or heading once it renders
  useEffect(() => {
    revealSummary();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries once the description markdown renders, including after its editor closes
  }, [revealUrl, description, checksReveals, descriptionReveals, editingDescription]);
  // oxlint-disable-next-line goat/react-effect-budget -- puts a remounted Summary back at the scroll position it left, before paint
  useLayoutEffect(() => {
    if (!scrollRef.current || initialScrollTop === 0) return;
    restoringScroll.current = true;
    stopHolding.current = holdScrollTop(scrollRef.current, initialScrollTop, () => {
      restoringScroll.current = false;
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- restores once per mount
  }, []);
  // oxlint-disable-next-line goat/react-effect-budget -- the hold observes DOM outside React and must end with the tab
  useEffect(() => () => stopHolding.current?.(), []);
  return { scrollRef, restoringScroll, checksReveals, descriptionReveals };
}

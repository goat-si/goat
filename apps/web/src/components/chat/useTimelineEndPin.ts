import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, type RefObject } from "react";
import { observeResize } from "../../lib/observeResize";
import { createUpwardScrollDetector } from "./timelineScrollTarget";

/**
 * Holds a following timeline at its measured end while content settles.
 *
 * LegendList's maintainScrollAtEnd only re-pins while the end is within its
 * threshold. When rows above and at the end grow in the same few frames (code
 * highlighting, decoded images and sized iframes after a thread opens), its
 * visible-content anchoring moves the scroll by the growth above while the end
 * moves further, and once the gap passes the threshold it never follows again.
 * Re-pinning after each content or viewport resize restores the end before paint.
 */
export function useTimelineEndPin({
  listRef,
  scrollNode,
  enabled,
  smooth,
}: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly scrollNode: HTMLElement | null;
  /** True exactly when the list maintains its end, so every opt-out still applies. */
  readonly enabled: boolean;
  /** Animated follow glides to an end within one viewport; only a lost end jumps. */
  readonly smooth: boolean;
}) {
  useEffect(() => {
    const content = scrollNode?.firstElementChild;
    if (!scrollNode || !content || !enabled) return;
    // Follow turns off through a React commit. A scroll that actually carried
    // the view up stops pinning before that lands; scroll events run before
    // resize observation in each frame. Content shrinking above is not the user.
    let released = false;
    const distanceFromEnd = () =>
      scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop;
    const measuredPosition = () => ({
      top: scrollNode.scrollTop,
      height: scrollNode.scrollHeight,
    });
    let scrolledUp = createUpwardScrollDetector(measuredPosition());
    const onScroll = () => {
      if (scrolledUp(measuredPosition())) {
        released = true;
      }
      if (released && distanceFromEnd() <= 1) released = false;
    };
    // LegendList corrects its anchor toward the offset it last saw, which can still predate a
    // pin on a slow frame. That move is the list's own, so upward movement is measured from
    // where it left the view. Its scrollBy runs inside the signal, before this microtask.
    const listAdjusted = () =>
      queueMicrotask(() => {
        scrolledUp = createUpwardScrollDetector(measuredPosition());
      });
    // The pinned LegendList 3.3.5 emits these signals from ScrollAdjust; its public listener
    // type leaves them out.
    const listen = listRef.current?.getState().listen as
      | ((signal: "scrollAdjust" | "scrollAdjustUserOffset", callback: () => void) => () => void)
      | undefined;
    const stopListening = [
      listen?.("scrollAdjust", listAdjusted),
      listen?.("scrollAdjustUserOffset", listAdjusted),
    ];
    // Only growth after follow turns on is ours to correct: an explicit
    // animated scroll to the end must not be cut short by an immediate jump.
    let height = scrollNode.scrollHeight;
    let viewportHeight = scrollNode.clientHeight;
    const pin = () => {
      if (scrollNode.scrollHeight === height && scrollNode.clientHeight === viewportHeight) return;
      height = scrollNode.scrollHeight;
      viewportHeight = scrollNode.clientHeight;
      const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
      const distance = distanceFromEnd();
      if (distance <= 1) released = false;
      if (released || !viewport) return;
      if (distance <= 1 || (smooth && distance <= viewportHeight)) return;
      viewport.scrollTop = viewport.scrollHeight;
      // Its scroll event arrives later and coalesces with any user scroll in
      // between, so upward movement is measured from where the pin landed.
      scrolledUp = createUpwardScrollDetector(measuredPosition());
    };
    scrollNode.addEventListener("scroll", onScroll, { passive: true });
    const stopObserving = observeResize([scrollNode, content], pin);
    return () => {
      stopObserving();
      scrollNode.removeEventListener("scroll", onScroll);
      for (const stop of stopListening) stop?.();
    };
  }, [enabled, listRef, scrollNode, smooth]);
}

import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, type RefObject } from "react";
import { observeResize } from "../../lib/observeResize";

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
    const pin = () => {
      const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
      if (!viewport) return;
      const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      if (distance <= 1 || (smooth && distance <= viewport.clientHeight)) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    pin();
    return observeResize([scrollNode, content], pin);
  }, [enabled, listRef, scrollNode, smooth]);
}

import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, type RefObject } from "react";
import { observeResize } from "../../lib/observeResize";

const UPWARD_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

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
    // Follow turns off through a React commit; a gesture that can carry the
    // view up must stop pinning before that lands, until the view is back at the end.
    let released = false;
    const distanceFromEnd = () =>
      scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop;
    const release = () => {
      released = true;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) release();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (UPWARD_KEYS.has(event.key)) release();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === scrollNode) release();
    };
    const onScroll = () => {
      if (released && distanceFromEnd() <= 1) released = false;
    };
    // Only growth after follow turns on is ours to correct: an explicit
    // animated scroll to the end must not be cut short by an immediate jump.
    let height = scrollNode.scrollHeight;
    let viewportHeight = scrollNode.clientHeight;
    const pin = () => {
      if (scrollNode.scrollHeight === height && scrollNode.clientHeight === viewportHeight) return;
      height = scrollNode.scrollHeight;
      viewportHeight = scrollNode.clientHeight;
      const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
      if (released || !viewport) return;
      const distance = distanceFromEnd();
      if (distance <= 1 || (smooth && distance <= viewportHeight)) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    scrollNode.addEventListener("wheel", onWheel, { passive: true });
    scrollNode.addEventListener("touchmove", release, { passive: true });
    scrollNode.addEventListener("pointerdown", onPointerDown, { passive: true });
    scrollNode.addEventListener("scroll", onScroll, { passive: true });
    scrollNode.ownerDocument.addEventListener("keydown", onKeyDown);
    const stopObserving = observeResize([scrollNode, content], pin);
    return () => {
      stopObserving();
      scrollNode.removeEventListener("wheel", onWheel);
      scrollNode.removeEventListener("touchmove", release);
      scrollNode.removeEventListener("pointerdown", onPointerDown);
      scrollNode.removeEventListener("scroll", onScroll);
      scrollNode.ownerDocument.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, listRef, scrollNode, smooth]);
}

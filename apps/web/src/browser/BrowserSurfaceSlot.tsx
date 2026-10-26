import { useEffectEvent, useLayoutEffect, useRef } from "react";

import {
  acquireBrowserSurface,
  type BrowserSurfaceLease,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";
import { observeResize } from "../lib/observeResize";

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly layoutVersion?: string | number;
  readonly className?: string;
  readonly fitSourceContent?: boolean;
  /**
   * Shows the tab only while no other slot holds it, and gives it up to any slot that claims it.
   * An agent card uses this so it never takes a tab from the right panel or the floating player.
   */
  readonly passive?: boolean;
  /** Whether this slot is the one presenting the tab right now. */
  readonly onPresentedChange?: (presented: boolean) => void;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    zIndex = 30,
    layoutVersion,
    className,
    fitSourceContent = false,
    passive = false,
  } = props;
  const presentationRef = useRef({ visible, cornerRadius, zIndex });
  const updateRef = useRef<(() => void) | null>(null);
  const presentedChange = useEffectEvent((presented: boolean) =>
    props.onPresentedChange?.(presented),
  );

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      return {
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        sized: rect.width > 0 && rect.height > 0,
      };
    };
    let presented = false;
    const setPresented = (next: boolean) => {
      if (presented === next) return;
      presented = next;
      presentedChange(next);
    };
    if (passive) {
      let lease: BrowserSurfaceLease | null = null;
      const update = () => {
        const { rect, sized } = measure();
        const shown = presentationRef.current.visible && sized;
        if (lease === null) {
          // Only a free tab is taken; a held one stays where it is shown.
          if (!shown || useBrowserSurfaceStore.getState().byTabId[tabId]?.owner) {
            setPresented(false);
            return;
          }
          lease = acquireBrowserSurface(tabId, fitSourceContent);
        }
        const { cornerRadius: radius, zIndex: layer } = presentationRef.current;
        if (!shown || !lease.present(rect, true, radius, layer)) {
          lease.release();
          lease = null;
          setPresented(false);
          return;
        }
        setPresented(true);
      };
      updateRef.current = update;
      update();
      // Another slot releasing the tab is when a passive slot may show it again.
      const unsubscribe = useBrowserSurfaceStore.subscribe((state, previous) => {
        if (state.byTabId[tabId]?.owner !== previous.byTabId[tabId]?.owner) update();
      });
      const stopObserving = observeResize(element, update);
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      return () => {
        unsubscribe();
        stopObserving();
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        if (updateRef.current === update) updateRef.current = null;
        lease?.release();
        setPresented(false);
      };
    }
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    const update = () => {
      const { rect, sized } = measure();
      const presentation = presentationRef.current;
      const shown = lease.present(
        rect,
        presentation.visible && sized,
        presentation.cornerRadius,
        presentation.zIndex,
      );
      if (presentation.visible && !shown) {
        lease.release();
        lease = acquireBrowserSurface(tabId, fitSourceContent);
        lease.present(rect, sized, presentation.cornerRadius, presentation.zIndex);
      }
    };
    updateRef.current = update;
    update();
    const observed: Element[] = [element];
    // Inline shells animate without resizing the slot, so observe the shell too.
    const panel = element.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    // Sidebar width changes move the slot without changing its size or column offset.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      stopObserving();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  }, [fitSourceContent, passive, tabId]);

  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
    updateRef.current?.();
  }, [
    cornerRadius,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A layoutVersion bump means the slot moved without resizing, so it re-presents at the new position.
    layoutVersion,
    visible,
    zIndex,
  ]);

  return <div ref={attachSurface} className={className} data-browser-surface-slot={tabId} />;
}

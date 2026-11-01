import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";

const GAP = 4;
const MIN_WIDTH = 96;
const MAX_WIDTH = 192;
const EDGE_TOLERANCE = 1;

function viewportOf(root: HTMLElement | null) {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

interface CloseLayout {
  beforeIds: string;
  afterIds: string;
  beforeActive: string | null;
  afterActive: string | null;
  width: number;
  span: number;
  holdWhilePending: boolean;
}

export function usePanelTabLayout(input: {
  ids: readonly string[];
  activeId: string | null;
  open: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [measurement, setMeasurement] = useState({ width: 0, addWidth: 32 });
  const [scrollState, setScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });
  const [closing, setClosing] = useState<CloseLayout | null>(null);
  const idsKey = JSON.stringify(input.ids);
  const pending = closing?.beforeIds === idsKey && closing.beforeActive === input.activeId;
  const frozen = closing?.afterIds === idsKey && closing.afterActive === input.activeId;
  const holding = frozen || (pending && closing.holdWhilePending);
  if (closing && (!input.open || (!pending && !frozen))) setClosing(null);

  const release = useStableCallback(() => setClosing(null));
  const naturalWidth = Math.min(
    MAX_WIDTH,
    Math.max(
      MIN_WIDTH,
      (measurement.width - measurement.addWidth - GAP - GAP * (input.ids.length - 1)) /
        Math.max(1, input.ids.length),
    ),
  );
  const tabWidth = holding ? closing.width : naturalWidth;
  const tabsWidth = input.ids.length * tabWidth + Math.max(0, input.ids.length - 1) * GAP;
  const retainedWidth = holding ? Math.max(tabsWidth, closing.span) : tabsWidth;

  const prepareClose = useStableCallback((id: string) => {
    const viewport = viewportOf(rootRef.current);
    const tabs = rootRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    const width = tabs?.[0]?.getBoundingClientRect().width;
    if (!viewport || !width || input.ids.length <= 1) {
      release();
      return;
    }
    const index = input.ids.indexOf(id);
    const remaining = input.ids.filter((entry) => entry !== id);
    setClosing({
      beforeIds: idsKey,
      afterIds: JSON.stringify(remaining),
      beforeActive: input.activeId,
      afterActive:
        input.activeId === id ? (remaining[index] ?? remaining[index - 1] ?? null) : input.activeId,
      width,
      span: retainedWidth,
      holdWhilePending: holding,
    });
  });

  const updateScroll = useStableCallback((viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - EDGE_TOLERANCE;
    setScrollState((current) =>
      current.hasOverflow === hasOverflow &&
      current.canScrollLeft === canScrollLeft &&
      current.canScrollRight === canScrollRight
        ? current
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  });

  const scrollTabs = (direction: -1 | 1) => {
    release();
    const viewport = viewportOf(rootRef.current);
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const measure = useStableCallback(() => {
    const viewport = viewportOf(rootRef.current);
    if (!viewport) return;
    const width = viewport.clientWidth;
    const addWidth = addButtonRef.current?.getBoundingClientRect().width ?? 0;
    setMeasurement((previous) => {
      if (previous.width === width && previous.addWidth === addWidth) return previous;
      setClosing(null);
      return { width, addWidth };
    });
    updateScroll(viewport);
  });

  const attachAddButton = useStableCallback((button: HTMLButtonElement | null) => {
    addButtonRef.current = button;
    measure();
    if (!button) return;
    const stopObserving = observeResize(button, measure);
    return () => {
      addButtonRef.current = null;
      stopObserving();
      measure();
    };
  });

  const attachTabList = useStableCallback((root: HTMLDivElement | null) => {
    rootRef.current = root;
    const viewport = viewportOf(root);
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      release();
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      const before = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft !== before) event.preventDefault();
    };
    const update = () => updateScroll(viewport);
    const content = viewport.firstElementChild;
    const elements = [viewport, ...(content ? [content] : [])];
    const stopObserving = observeResize(elements, measure);
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    measure();
    return () => {
      rootRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", handleWheel);
    };
  });

  const activeId = input.activeId;
  const revealActiveTab = useEffectEvent(() => {
    if (holding) return;
    rootRef.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Synchronizes browser scroll with selection and newly overflowing tabs.
  useEffect(() => {
    if (!input.open || !scrollState.hasOverflow || !activeId) return;
    revealActiveTab();
  }, [activeId, input.open, scrollState.hasOverflow]);

  return {
    attachTabList,
    attachAddButton,
    addButtonRef,
    scrollState,
    scrollTabs,
    tabWidth,
    retainedWidth,
    prepareClose,
    release,
  };
}

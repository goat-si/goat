const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_TARGET_OFFSET = 24;
// Relative to the timeline, not the viewport, so an open terminal shrinks the rail and
// endpoint previews (centered on their strip) still fit above and below it.
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "max(4rem, calc(100% - 14.75rem))";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

// Streaming can briefly unset isAtEnd; re-arm near the content bottom.
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // LegendList double-subtracts the composer inset, so its isAtEnd is only a fallback.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** Recheck the rendered buffer: LegendList's unbuffered range can lag during scrolling. */
export function resolveTimelineMinimapVisibleRange(state: {
  readonly startBuffered: number | null | undefined;
  readonly endBuffered: number | null | undefined;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}) {
  let start: number | null = null;
  let end: number | null = null;
  if (state.startBuffered == null || state.endBuffered == null || state.startBuffered < 0) {
    return { start, end };
  }
  const bottom = state.scroll + state.scrollLength;
  for (let index = state.startBuffered; index <= state.endBuffered; index += 1) {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
      top != null &&
      Number.isFinite(top) &&
      top < bottom &&
      top + Math.max(1, height != null && Number.isFinite(height) ? height : 1) > state.scroll
    ) {
      start ??= index;
      end = index;
    }
  }
  return { start, end };
}

export function isTimelineMinimapRowVisible(
  rowIndex: number,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
): boolean {
  return (
    visibleStart != null && visibleEnd != null && rowIndex >= visibleStart && rowIndex <= visibleEnd
  );
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly visibleStart: number | null | undefined;
  readonly visibleEnd: number | null | undefined;
  readonly rowIndices: ReadonlyArray<number>;
}): number | null {
  if (input.visibleStart == null || input.visibleEnd == null) {
    return null;
  }
  let precedingIndex: number | null = null;
  for (const [index, rowIndex] of input.rowIndices.entries()) {
    if (rowIndex >= input.visibleStart) {
      // Prefer the first visible user message, otherwise the turn being read.
      return rowIndex <= input.visibleEnd ? index : precedingIndex;
    }
    precedingIndex = index;
  }
  return precedingIndex;
}

function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;

export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

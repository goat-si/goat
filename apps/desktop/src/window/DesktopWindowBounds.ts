export type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

interface RectEdges {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

// A window snapped to a display edge can be reported 1px past that edge.
const SAVED_BOUNDS_EDGE_TOLERANCE_PX = 1;

function toRectEdges(bounds: DisplayBounds): RectEdges {
  return {
    left: bounds.x,
    top: bounds.y,
    right: bounds.x + bounds.width,
    bottom: bounds.y + bounds.height,
  };
}

function insetRectEdges(rect: RectEdges, by: number): RectEdges {
  return {
    left: rect.left + by,
    top: rect.top + by,
    right: rect.right - by,
    bottom: rect.bottom - by,
  };
}

function subtractRect(rect: RectEdges, cover: RectEdges): readonly RectEdges[] {
  const overlapLeft = Math.max(rect.left, cover.left);
  const overlapTop = Math.max(rect.top, cover.top);
  const overlapRight = Math.min(rect.right, cover.right);
  const overlapBottom = Math.min(rect.bottom, cover.bottom);

  if (overlapLeft >= overlapRight || overlapTop >= overlapBottom) {
    return [rect];
  }

  const remainder: RectEdges[] = [];
  if (rect.left < overlapLeft) {
    remainder.push({
      left: rect.left,
      top: rect.top,
      right: overlapLeft,
      bottom: rect.bottom,
    });
  }
  if (overlapRight < rect.right) {
    remainder.push({
      left: overlapRight,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
  }
  if (rect.top < overlapTop) {
    remainder.push({
      left: overlapLeft,
      top: rect.top,
      right: overlapRight,
      bottom: overlapTop,
    });
  }
  if (overlapBottom < rect.bottom) {
    remainder.push({
      left: overlapLeft,
      top: overlapBottom,
      right: overlapRight,
      bottom: rect.bottom,
    });
  }
  return remainder;
}

export function fitsWithinDisplays(
  windowBounds: DisplayBounds,
  displays: readonly DisplayBounds[],
): boolean {
  if (windowBounds.width <= 0 || windowBounds.height <= 0 || displays.length === 0) {
    return false;
  }

  let uncovered: readonly RectEdges[] = [
    insetRectEdges(toRectEdges(windowBounds), SAVED_BOUNDS_EDGE_TOLERANCE_PX),
  ];
  for (const display of displays) {
    if (display.width <= 0 || display.height <= 0) {
      continue;
    }
    const cover = toRectEdges(display);
    uncovered = uncovered.flatMap((rect) => subtractRect(rect, cover));
    if (uncovered.length === 0) {
      return true;
    }
  }
  return uncovered.length === 0;
}

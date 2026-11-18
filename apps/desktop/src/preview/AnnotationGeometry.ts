import type { PreviewAnnotationRect } from "@goat/contracts";

export const rectFromDomRect = (rect: DOMRect): PreviewAnnotationRect => ({
  x: rect.left,
  y: rect.top,
  width: rect.width,
  height: rect.height,
});

export const normalizeRect = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PreviewAnnotationRect => ({
  x: Math.min(startX, endX),
  y: Math.min(startY, endY),
  width: Math.abs(endX - startX),
  height: Math.abs(endY - startY),
});

export const isUsableRect = (rect: PreviewAnnotationRect): boolean =>
  rect.width >= 3 && rect.height >= 3;

export function unionRects(
  rects: ReadonlyArray<PreviewAnnotationRect>,
  padding = 20,
): PreviewAnnotationRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  // Main clips to the captured viewport; clipping here would lose offscreen bounds.
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

export function visibleElementRect(
  element: Element,
  rect = element.getBoundingClientRect(),
): PreviewAnnotationRect {
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(document.documentElement.clientWidth, rect.right);
  let bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
  if (getComputedStyle(element).position !== "fixed") {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement) break;
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      const clipLeft = bounds.left + ancestor.clientLeft;
      const clipTop = bounds.top + ancestor.clientTop;
      if (style.overflowX !== "visible") {
        left = Math.max(left, clipLeft);
        right = Math.min(right, clipLeft + ancestor.clientWidth);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, clipTop);
        bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
      }
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

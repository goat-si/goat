export interface PdfSize {
  readonly width: number;
  readonly height: number;
}
export type PdfZoom = "fit-width" | "fit-page" | number;
const PDF_GAP = 16;
export const clampScale = (scale: number) =>
  Math.min(5, Math.max(0.1, Number.isFinite(scale) ? scale : 1));

/** Each page fits independently: a landscape insert must not overflow portrait fit-width. */
function pageScale(size: PdfSize, container: PdfSize, zoom: PdfZoom) {
  if (typeof zoom === "number") return clampScale(zoom);
  const width = Math.max(1, container.width - PDF_GAP * 2) / size.width;
  return clampScale(
    zoom === "fit-width"
      ? width
      : Math.min(width, Math.max(1, container.height - PDF_GAP * 2) / size.height),
  );
}

export function layoutPages(sizes: readonly PdfSize[], container: PdfSize, zoom: PdfZoom) {
  let top = PDF_GAP;
  return sizes.map((size) => {
    const scale = pageScale(size, container, zoom);
    const page = { top, width: size.width * scale, height: size.height * scale, scale };
    top += page.height + PDF_GAP;
    return page;
  });
}

/** Binary search avoids scanning a long document on every scroll event. */
export function pageAtOffset(pages: readonly { top: number; height: number }[], offset: number) {
  let low = 0;
  let high = pages.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const page = pages[mid]!;
    if (page.top + page.height + PDF_GAP <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visiblePages(pages: ReturnType<typeof layoutPages>, top: number, height: number) {
  if (pages.length === 0) return [];
  const first = pageAtOffset(pages, top);
  const last = pageAtOffset(pages, top + height);
  return pages
    .slice(first, last + 1)
    .map((page, index) => ({ ...page, index: first + index }))
    .filter((page) => page.top < top + height && page.top + page.height > top);
}

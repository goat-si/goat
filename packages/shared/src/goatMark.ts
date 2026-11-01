/**
 * The GOAT mark (direction B2): two crescent horns curling inward above an upward peak.
 * Geometry lives on a 24-unit grid; every renderer (web, React Native, icon scripts,
 * Android vector, widget SVG) draws these same paths so the mark cannot drift.
 */
export const GOAT_MARK_GRID = 24;
/** Tight square around the mark, centered on (12, 12); use for icon-sized boxes. */
export const GOAT_MARK_VIEWBOX = "2 2 20 20";
/** Tight box around the visible ink; use where width follows height (mobile lockups). */
export const GOAT_MARK_INK_BOX = { x: 2, y: 6.2, width: 20, height: 11.6 } as const;
export const GOAT_MARK_HORNS_PATH =
  "M2.809 13.261 A4.65 4.65 0 0 1 11.1 9.054 L9.397 11.233 A3.45 3.45 0 0 0 2.809 13.261 Z M 21.191 13.261 A 4.65 4.65 0 0 0 12.9 9.054 L 14.603 11.233 A 3.45 3.45 0 0 1 21.191 13.261 Z";
/** Round-join stroke drawn over the filled horns to soften their corners. */
export const GOAT_MARK_HORNS_SOFTEN_WIDTH = 0.6;
export const GOAT_MARK_PEAK_PATH = "M7.814 16.508 L12 11.15 L16.186 16.508";
export const GOAT_MARK_PEAK_WIDTH = 2.3;

/** SVG elements for the mark in one color, for scripts and static assets. */
export function goatMarkSvgElements(color: string): string {
  return (
    `<path d="${GOAT_MARK_HORNS_PATH}" fill="${color}" stroke="${color}" stroke-width="${GOAT_MARK_HORNS_SOFTEN_WIDTH}" stroke-linejoin="round"/>` +
    `<path d="${GOAT_MARK_PEAK_PATH}" fill="none" stroke="${color}" stroke-width="${GOAT_MARK_PEAK_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

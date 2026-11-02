/**
 * Paint-order occlusion, ported from browser-use's Rect and RectUnionPure
 * (browser_use/dom/serializer/paint_order.py, MIT licensed).
 */

/** A closed axis-aligned rectangle with x1 <= x2 and y1 <= y2. */
export interface PaintRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export const paintRect = (x: number, y: number, width: number, height: number): PaintRect => ({
  x1: x,
  y1: y,
  x2: x + width,
  y2: y + height,
});

export const rectArea = (r: PaintRect): number => (r.x2 - r.x1) * (r.y2 - r.y1);

/** Rectangles that only share an edge do not overlap. */
const rectsIntersect = (a: PaintRect, b: PaintRect): boolean =>
  !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);

const rectContains = (outer: PaintRect, inner: PaintRect): boolean =>
  outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;

/** Finite coordinates and a positive area; anything else can neither cover nor be covered. */
const isPaintable = (r: PaintRect): boolean =>
  Number.isFinite(r.x1) &&
  Number.isFinite(r.y1) &&
  Number.isFinite(r.x2) &&
  Number.isFinite(r.y2) &&
  r.x2 > r.x1 &&
  r.y2 > r.y1;

/**
 * A union of rectangles kept as disjoint pieces. Every add can split what it overlaps into up to
 * four pieces, so a page with thousands of overlapping layers would grow without bound. At its
 * limit the union stops growing and answers from what it holds, which can only under-report
 * coverage: an element is never hidden because the union ran out of room.
 */
export class RectUnion {
  static readonly MAX_RECTS = 5000;
  readonly #rects: PaintRect[] = [];
  readonly #maxRects: number;
  readonly #maxPieces: number;

  /** maxRects bounds the stored pieces and maxPieces the pieces one contains() check may hold. */
  constructor(limits: { readonly maxRects?: number; readonly maxPieces?: number } = {}) {
    this.#maxRects = limits.maxRects ?? RectUnion.MAX_RECTS;
    this.#maxPieces = limits.maxPieces ?? RectUnion.MAX_RECTS;
  }

  get size(): number {
    return this.#rects.length;
  }

  /** a minus b as up to four disjoint pieces: bottom, top, then left and right of their shared band. */
  splitDiff(a: PaintRect, b: PaintRect): readonly PaintRect[] {
    const parts: PaintRect[] = [];
    if (a.y1 < b.y1) parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 });
    if (b.y2 < a.y2) parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 });
    const yLo = Math.max(a.y1, b.y1);
    const yHi = Math.min(a.y2, b.y2);
    if (a.x1 < b.x1) parts.push({ x1: a.x1, y1: yLo, x2: b.x1, y2: yHi });
    if (b.x2 < a.x2) parts.push({ x1: b.x2, y1: yLo, x2: a.x2, y2: yHi });
    return parts;
  }

  /** The pieces of r left uncovered by the union, or undefined once they outgrow budget. */
  #carve(r: PaintRect, budget: number): PaintRect[] | undefined {
    let pieces = [r];
    for (const stored of this.#rects) {
      const next: PaintRect[] = [];
      for (const piece of pieces) {
        if (!rectsIntersect(piece, stored)) next.push(piece);
        else if (!rectContains(stored, piece)) next.push(...this.splitDiff(piece, stored));
      }
      if (next.length === 0) return next;
      if (next.length > budget) return undefined;
      pieces = next;
    }
    return pieces;
  }

  /** True only when r is fully covered; a check that outgrows maxPieces answers false. */
  contains(r: PaintRect): boolean {
    if (this.#rects.length === 0 || !isPaintable(r)) return false;
    return this.#carve(r, this.#maxPieces)?.length === 0;
  }

  /** Adds the part of r not yet covered; false when nothing new was stored. */
  add(r: PaintRect): boolean {
    if (!isPaintable(r)) return false;
    const room = this.#maxRects - this.#rects.length;
    if (room <= 0) return false;
    const pieces = this.#carve(r, room);
    // Too many pieces for the room left: the union stays as it was rather than store part of r.
    if (pieces === undefined || pieces.length === 0) return false;
    this.#rects.push(...pieces);
    return true;
  }
}

/** One element's box in paint order; a higher paintOrder paints later, on top. */
export interface PaintItem {
  readonly bounds: PaintRect;
  readonly paintOrder?: number;
  /** Only an element known to paint its whole box solidly can hide what lies under it. */
  readonly opaque?: boolean;
  /** Paint order only compares within one document, so each keeps its own union. */
  readonly document?: string;
}

/**
 * Marks each item whose box is fully covered by opaque items painted above it. Items sharing a
 * paint order never hide each other. An item without a paint order or a paintable box is never
 * marked, so missing data leaves elements visible.
 */
export const computePaintOrderOcclusion = <T extends PaintItem>(
  items: readonly T[],
): ReadonlyArray<T & { readonly occludedByPaintOrder: boolean }> => {
  const ordered = items
    .flatMap((item, index) =>
      item.paintOrder !== undefined && Number.isFinite(item.paintOrder) && isPaintable(item.bounds)
        ? [{ item, index, paintOrder: item.paintOrder }]
        : [],
    )
    .sort((a, b) => b.paintOrder - a.paintOrder);
  const unions = new Map<string | undefined, RectUnion>();
  const unionOf = (document: string | undefined) => {
    const existing = unions.get(document);
    if (existing) return existing;
    const created = new RectUnion();
    unions.set(document, created);
    return created;
  };
  const occluded = new Set<number>();
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (ordered[end]?.paintOrder === ordered[start]?.paintOrder) end++;
    const group = ordered.slice(start, end);
    for (const { item, index } of group)
      if (unionOf(item.document).contains(item.bounds)) occluded.add(index);
    for (const { item } of group) if (item.opaque === true) unionOf(item.document).add(item.bounds);
    start = end;
  }
  return items.map((item, index) => ({ ...item, occludedByPaintOrder: occluded.has(index) }));
};

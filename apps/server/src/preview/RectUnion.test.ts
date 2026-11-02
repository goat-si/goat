import { describe, expect, it } from "@effect/vitest";
import {
  computePaintOrderOcclusion,
  type PaintItem,
  paintRect,
  rectArea,
  RectUnion,
} from "./RectUnion.ts";

describe("rectangle union and paint-order occlusion", () => {
  it("hides an inner rectangle under an opaque cover", () => {
    const inner = paintRect(1, 1, 1, 1);
    const cover = paintRect(0, 0, 3, 3);
    const union = new RectUnion();
    expect(union.add(cover)).toBe(true);
    expect(union.contains(inner)).toBe(true);
    expect(
      computePaintOrderOcclusion([
        { bounds: inner, paintOrder: 1 },
        { bounds: cover, paintOrder: 2, opaque: true },
      ]).map((item) => item.occludedByPaintOrder),
    ).toEqual([true, false]);
  });

  it("covers a target with halves or quadrants and splits a center hole into disjoint pieces", () => {
    const target = paintRect(0, 0, 3, 3);
    for (const pieces of [
      [paintRect(0, 0, 1.5, 3), paintRect(1.5, 0, 1.5, 3)],
      [
        paintRect(0, 0, 1.5, 1.5),
        paintRect(1.5, 0, 1.5, 1.5),
        paintRect(0, 1.5, 1.5, 1.5),
        paintRect(1.5, 1.5, 1.5, 1.5),
      ],
    ]) {
      const union = new RectUnion();
      for (const piece of pieces) expect(union.add(piece)).toBe(true);
      expect(union.contains(target)).toBe(true);
    }

    const hole = paintRect(1, 1, 1, 1);
    const pieces = new RectUnion().splitDiff(target, hole);
    expect(pieces).toEqual([
      paintRect(0, 0, 3, 1),
      paintRect(0, 2, 3, 1),
      paintRect(0, 1, 1, 1),
      paintRect(2, 1, 1, 1),
    ]);
    expect(pieces.reduce((sum, piece) => sum + rectArea(piece), 0)).toBe(9 - 1);
    for (const [index, a] of pieces.entries()) {
      for (const b of pieces.slice(index + 1)) {
        expect(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1).toBe(true);
      }
    }
  });

  it("keeps targets visible when coverage or paint information is insufficient", () => {
    const target = { bounds: paintRect(0, 0, 3, 3), paintOrder: 1, document: "a" };
    const cover = { bounds: paintRect(0, 0, 3, 3), paintOrder: 2, opaque: true, document: "a" };
    const cases: ReadonlyArray<readonly [PaintItem, PaintItem]> = [
      [target, { ...cover, bounds: paintRect(0, 0, 2, 3) }],
      [target, { ...cover, opaque: false }],
      [target, { bounds: cover.bounds, paintOrder: 2, document: "a" }],
      [target, { ...cover, paintOrder: 1 }],
      [target, { ...cover, document: "b" }],
      [{ bounds: target.bounds, document: "a" }, cover],
      [{ ...target, bounds: paintRect(NaN, 0, 3, 3) }, cover],
      [{ ...target, bounds: paintRect(0, 0, Infinity, 3) }, cover],
      [target, { ...cover, bounds: paintRect(NaN, 0, 3, 3) }],
      [target, { ...cover, bounds: paintRect(0, 0, Infinity, 3) }],
      [{ ...target, paintOrder: NaN }, cover],
      [{ ...target, paintOrder: Infinity }, cover],
      [target, { ...cover, paintOrder: NaN }],
      [target, { ...cover, paintOrder: Infinity }],
      [target, { ...cover, bounds: paintRect(3, 0, 3, 3) }],
    ];
    for (const items of cases) {
      expect(computePaintOrderOcclusion(items).map((item) => item.occludedByPaintOrder)).toEqual([
        false,
        false,
      ]);
    }
  });

  it("leaves new coverage visible when the 5000-rectangle limit is full", () => {
    const union = new RectUnion();
    for (let i = 0; i < 5000; i++) expect(union.add(paintRect(i * 2, 0, 1, 1))).toBe(true);
    expect(union.size).toBe(RectUnion.MAX_RECTS);
    expect(RectUnion.MAX_RECTS).toBe(5000);
    expect(union.add(paintRect(0, 0, 10000, 2))).toBe(false);
    expect(union.size).toBe(5000);
    expect(union.contains(paintRect(1, 0, 1, 1))).toBe(false);
  });

  it("rejects an add atomically when its pieces exceed the remaining capacity", () => {
    const union = new RectUnion({ maxRects: 4 });
    const hole = paintRect(1, 1, 1, 1);
    const target = paintRect(0, 0, 3, 3);
    expect(union.add(hole)).toBe(true);
    expect(union.add(target)).toBe(false);
    expect(union.size).toBe(1);
    expect(union.contains(hole)).toBe(true);
    expect(union.contains(target)).toBe(false);
  });

  it("leaves a covered target visible when the containment piece budget is exceeded", () => {
    const limited = new RectUnion({ maxPieces: 3 });
    const normal = new RectUnion();
    const hole = paintRect(1, 1, 1, 1);
    const target = paintRect(0, 0, 3, 3);
    for (const union of [limited, normal]) {
      expect(union.add(hole)).toBe(true);
      expect(union.add(target)).toBe(true);
      expect(union.size).toBe(5);
    }
    expect(limited.contains(target)).toBe(false);
    expect(normal.contains(target)).toBe(true);
  });
});

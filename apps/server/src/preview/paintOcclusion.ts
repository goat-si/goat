/**
 * Marks the snapshot refs that solid content paints over, from CDP's paint-order layout snapshot.
 * An aria ref names no node, only its rounded viewport box, so each rule here can only drop a mark:
 * a ref is marked when covers proven to paint solidly, above every node with its box, hide them.
 */
import type { CDPSession } from "playwright-core";
import { RectUnion, type PaintRect } from "./RectUnion.ts";

const STYLES = [
  "background-color",
  "opacity",
  "visibility",
  "display",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "background-clip",
  "clip-path",
  "mask-image",
  "filter",
  "transform",
  "rotate",
  "scale",
  "translate",
  "mix-blend-mode",
  "overflow-x",
  "overflow-y",
  "clip",
  "contain",
  "zoom",
  "column-count",
  "column-width",
] as const;
type StyleName = (typeof STYLES)[number];
const at = Object.fromEntries(STYLES.map((name, index) => [name, index])) as Record<
  StyleName,
  number
>;
const RADII = STYLES.slice(4, 8).map((name) => at[name]);
const UNALTERED = (
  ["clip-path", "mask-image", "filter", "transform", "rotate", "scale", "translate"] as const
).map((name) => at[name]);
/** Covers are bucketed by this many CSS pixels, so a ref only meets the covers near it. */
const CELL = 128;
/** A cover or ref spanning more cells than this, such as an endless page's background, is left out. */
const MAX_CELLS = 20_000;
const span = (rect: PaintRect) =>
  (Math.floor(rect.x2 / CELL) - Math.floor(rect.x1 / CELL) + 1) *
  (Math.floor(rect.y2 / CELL) - Math.floor(rect.y1 / CELL) + 1);

type Style = ReadonlyArray<string>;
type Painted = {
  readonly box: readonly [number, number, number, number];
  readonly bounds: PaintRect;
  readonly paintOrder: number;
  readonly style: Style;
};
type Cover = { readonly node: number; readonly rect: PaintRect; readonly paintOrder: number };

/** The main document's layout in paint order; undefined when the browser cannot provide it. */
export const capturePaint = (cdp: CDPSession): Promise<unknown> =>
  cdp
    .send("DOMSnapshot.captureSnapshot", { computedStyles: [...STYLES], includePaintOrder: true })
    .catch(() => undefined);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;
const isIntegers = (value: unknown, length: number): value is ReadonlyArray<number> =>
  Array.isArray(value) && value.length === length && value.every(Number.isInteger);
const isList = (value: unknown, length: number): value is ReadonlyArray<unknown> =>
  Array.isArray(value) && value.length === length;
const isRect = (value: unknown): value is readonly [number, number, number, number] =>
  Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const scrollOffset = (value: unknown) =>
  value === undefined ? 0 : typeof value === "number" && Number.isFinite(value) ? value : NaN;

const intersect = (a: PaintRect, b: PaintRect | undefined): PaintRect =>
  b === undefined
    ? a
    : {
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
        x2: Math.min(a.x2, b.x2),
        y2: Math.min(a.y2, b.y2),
      };
const overlaps = (a: PaintRect, b: PaintRect) =>
  a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/** Nodes in document order, so a parent always comes first, with each element's layout. */
const readDocument = (shot: unknown) => {
  if (!isRecord(shot) || !Array.isArray(shot.strings) || !Array.isArray(shot.documents)) return;
  const strings: ReadonlyArray<unknown> = shot.strings;
  const document: unknown = shot.documents[0];
  if (!isRecord(document) || !isRecord(document.nodes) || !isRecord(document.layout)) return;
  const { parentIndex, nodeType, nodeName } = document.nodes;
  const { nodeIndex, bounds, paintOrders, styles } = document.layout;
  if (!Array.isArray(parentIndex) || !Array.isArray(nodeIndex)) return;
  const [count, entries] = [parentIndex.length, nodeIndex.length];
  if (!isIntegers(parentIndex, count) || !isIntegers(nodeIndex, entries)) return;
  if (parentIndex.some((parent, node) => parent < -1 || parent >= node)) return;
  if (!isIntegers(nodeType, count) || !isIntegers(nodeName, count)) return;
  if (nodeIndex.some((node) => node < 0 || node >= count)) return;
  if (!isList(bounds, entries) || !isList(paintOrders, entries) || !isList(styles, entries)) return;
  const scrollX = scrollOffset(document.scrollOffsetX);
  const scrollY = scrollOffset(document.scrollOffsetY);
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return;
  const layouts = new Map<number, Painted>();
  for (let entry = 0; entry < entries; entry++) {
    const node = nodeIndex[entry] ?? -1;
    // The document and text nodes have no element box, and the document no styles.
    if (nodeType[node] !== 1 || layouts.has(node)) continue;
    const [box, paintOrder, indexes] = [bounds[entry], paintOrders[entry], styles[entry]];
    if (!isRect(box) || typeof paintOrder !== "number" || !Number.isFinite(paintOrder)) return;
    if (!isIntegers(indexes, STYLES.length)) return;
    const style: Array<string> = [];
    for (const index of indexes) {
      const value = strings[index];
      if (typeof value !== "string") return;
      style.push(value);
    }
    const [x, y, width, height] = [box[0] - scrollX, box[1] - scrollY, box[2], box[3]];
    layouts.set(node, {
      box: [x, y, width, height],
      bounds: { x1: x, y1: y, x2: x + width, y2: y + height },
      paintOrder,
      style,
    });
  }
  return { parents: parentIndex, layouts, names: nodeName.map((name) => strings[name]) };
};

const px = (style: Style, name: StyleName) => Number.parseFloat(style[at[name]] ?? "") || 0;
const visible = (style: Style) =>
  style[at["overflow-x"]] === "visible" && style[at["overflow-y"]] === "visible";
/** Content clips at the padding box, the overflow clip edge. */
const paddingBox = ({ bounds, style }: Painted): PaintRect => ({
  x1: bounds.x1 + px(style, "border-left-width"),
  y1: bounds.y1 + px(style, "border-top-width"),
  x2: bounds.x2 - px(style, "border-right-width"),
  y2: bounds.y2 - px(style, "border-bottom-width"),
});

/** Native refs, such as e12, whose whole box lies under solid content painted above it. */
export const occludedRefs = (shot: unknown, tree: string): ReadonlySet<string> => {
  const document = readDocument(shot);
  const occluded = new Set<string>();
  if (document === undefined) return occluded;
  const { parents, layouts, names } = document;
  // The root's overflow, and the body's while the root's is visible, apply to the viewport instead.
  const clips = (node: number, { style }: Painted) => {
    if (names[node] === "HTML") return false;
    const parent = layouts.get(parents[node] ?? -1);
    if (
      names[node] === "BODY" &&
      names[parents[node] ?? -1] === "HTML" &&
      (!parent || visible(parent.style))
    )
      return false;
    return !visible(style) || /paint|strict|content/.test(style[at.contain] ?? "");
  };
  /**
   * Paints itself and its descendants unaltered and unfragmented, at its computed sizes, and clips
   * them, if at all, to a rectangle. A column's fragments share one box that spans the gaps.
   */
  const plain = (node: number, layout: Painted) =>
    layout.style[at.opacity] === "1" &&
    layout.style[at["mix-blend-mode"]] === "normal" &&
    layout.style[at.clip] === "auto" &&
    layout.style[at.zoom] === "1" &&
    layout.style[at["column-count"]] === "auto" &&
    layout.style[at["column-width"]] === "auto" &&
    UNALTERED.every((index) => layout.style[index] === "none") &&
    (!clips(node, layout) || RADII.every((index) => layout.style[index] === "0px"));
  const plainAbove: Array<boolean> = [];
  const clipAbove: Array<PaintRect | undefined> = [];
  for (let node = 0; node < parents.length; node++) {
    const parent = parents[node] ?? -1;
    const layout = layouts.get(parent);
    plainAbove[node] =
      parent < 0 || ((plainAbove[parent] ?? false) && (!layout || plain(parent, layout)));
    clipAbove[node] =
      layout && clips(parent, layout)
        ? intersect(paddingBox(layout), clipAbove[parent])
        : clipAbove[parent];
  }
  const grid = new Map<string, Array<Cover>>();
  const cells = (rect: PaintRect) => {
    const keys: Array<string> = [];
    for (let cx = Math.floor(rect.x1 / CELL); cx <= Math.floor(rect.x2 / CELL); cx++)
      for (let cy = Math.floor(rect.y1 / CELL); cy <= Math.floor(rect.y2 / CELL); cy++)
        keys.push(`${cx},${cy}`);
    return keys;
  };
  const byBox = new Map<string, Array<number>>();
  for (const [node, layout] of layouts) {
    const key = layout.box.map(Math.round).join(",");
    const same = byBox.get(key);
    if (same) same.push(node);
    else byBox.set(key, [node]);
    const { style } = layout;
    const solid =
      (plainAbove[node] ?? false) &&
      plain(node, layout) &&
      // An inline box is the bounding box of its line fragments, not a painted rectangle.
      style[at.display] !== "inline" &&
      /^rgb\(/.test(style[at["background-color"]] ?? "") &&
      style[at.visibility] === "visible" &&
      style[at["background-clip"]] === "border-box" &&
      RADII.every((index) => style[index] === "0px");
    const rect = intersect(layout.bounds, clipAbove[node]);
    if (!solid || rect.x2 <= rect.x1 || rect.y2 <= rect.y1) continue;
    const cover = { node, rect, paintOrder: layout.paintOrder };
    if (span(rect) > MAX_CELLS) continue;
    for (const cell of cells(rect)) {
      const bucket = grid.get(cell);
      if (bucket) bucket.push(cover);
      else grid.set(cell, [cover]);
    }
  }
  if (grid.size === 0) return occluded;
  for (const [, ref, x, y, width, height] of tree.matchAll(
    /\[ref=(e\d+)\][^\n]*?\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/g,
  )) {
    const candidates = byBox.get(`${x},${y},${width},${height}`) ?? [];
    if (ref === undefined || candidates.length === 0) continue;
    let [first, top] = [Infinity, -Infinity];
    let enclosure: PaintRect = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const node of candidates) {
      const layout = layouts.get(node);
      if (!layout) continue;
      first = Math.min(first, node);
      top = Math.max(top, layout.paintOrder);
      enclosure = {
        x1: Math.min(enclosure.x1, layout.bounds.x1),
        y1: Math.min(enclosure.y1, layout.bounds.y1),
        x2: Math.max(enclosure.x2, layout.bounds.x2),
        y2: Math.max(enclosure.y2, layout.bounds.y2),
      };
    }
    const descends = (node: number) => {
      for (let above = parents[node] ?? -1; above >= first; above = parents[above] ?? -1)
        if (candidates.includes(above)) return true;
      return false;
    };
    const union = new RectUnion();
    const seen = new Set<Cover>();
    if (span(enclosure) > MAX_CELLS) continue;
    for (const cell of cells(enclosure))
      for (const cover of grid.get(cell) ?? []) {
        if (seen.has(cover)) continue;
        seen.add(cover);
        if (cover.paintOrder > top && overlaps(cover.rect, enclosure) && !descends(cover.node))
          union.add(cover.rect);
      }
    if (union.contains(enclosure)) occluded.add(ref);
  }
  return occluded;
};

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
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
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
] as const;
type Style = Readonly<Record<(typeof STYLES)[number], string>>;
type Painted = {
  readonly box: readonly [number, number, number, number];
  readonly bounds: PaintRect;
  readonly padding: PaintRect;
  readonly paintOrder: number;
  readonly style: Style;
};
const RADII = STYLES.slice(3, 7);
const UNTRANSFORMED = [
  "clip-path",
  "mask-image",
  "filter",
  "transform",
  "rotate",
  "scale",
  "translate",
] as const;

/** The main document's layout in paint order; undefined when the browser cannot provide it. */
export const capturePaint = (cdp: CDPSession): Promise<unknown> =>
  cdp
    .send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...STYLES],
      includePaintOrder: true,
      includeDOMRects: true,
    })
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
  const { nodeIndex, bounds, clientRects, paintOrders, styles } = document.layout;
  if (!Array.isArray(parentIndex) || !Array.isArray(nodeIndex)) return;
  const [count, entries] = [parentIndex.length, nodeIndex.length];
  if (!isIntegers(parentIndex, count) || !isIntegers(nodeIndex, entries)) return;
  if (parentIndex.some((parent, node) => parent < -1 || parent >= node)) return;
  if (!isIntegers(nodeType, count) || !isIntegers(nodeName, count)) return;
  if (nodeIndex.some((node) => node < 0 || node >= count)) return;
  if (!isList(bounds, entries) || !isList(clientRects, entries)) return;
  if (!isList(paintOrders, entries) || !isList(styles, entries)) return;
  const scrollX = scrollOffset(document.scrollOffsetX);
  const scrollY = scrollOffset(document.scrollOffsetY);
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) return;
  const layouts = new Map<number, Painted>();
  for (let entry = 0; entry < entries; entry++) {
    const node = nodeIndex[entry] ?? -1;
    // The document and text nodes have no element box: empty client rects, and no styles for the document.
    if (nodeType[node] !== 1 || layouts.has(node)) continue;
    const [box, client, paintOrder, indexes] = [
      bounds[entry],
      clientRects[entry],
      paintOrders[entry],
      styles[entry],
    ];
    if (!isRect(box) || typeof paintOrder !== "number") return;
    if (!Number.isFinite(paintOrder) || !isIntegers(indexes, STYLES.length)) return;
    const values = indexes.map((index) => strings[index]);
    if (!values.every((value) => typeof value === "string")) return;
    const [x, y, width, height] = [box[0] - scrollX, box[1] - scrollY, box[2], box[3]];
    // Without a client rect there is no padding box to clip to, so it clips everything away.
    const [left, top, clientWidth, clientHeight] = isRect(client)
      ? [x + client[0], y + client[1], client[2], client[3]]
      : [x, y, 0, 0];
    layouts.set(node, {
      box: [x, y, width, height],
      bounds: { x1: x, y1: y, x2: x + width, y2: y + height },
      padding: { x1: left, y1: top, x2: left + clientWidth, y2: top + clientHeight },
      paintOrder,
      style: Object.fromEntries(STYLES.map((name, at) => [name, values[at]])) as Style,
    });
  }
  const names = nodeName.map((name) => strings[name]);
  return { parents: parentIndex, layouts, names };
};

/** Clips its descendants to its padding box; the root and body hand overflow to the viewport. */
const clipsContents = (style: Style, name: unknown) =>
  name !== "HTML" &&
  name !== "BODY" &&
  (style["overflow-x"] !== "visible" ||
    style["overflow-y"] !== "visible" ||
    /paint|strict|content/.test(style.contain));

/** Paints itself and its descendants unaltered, and clips them, if at all, to a rectangle. */
const isPlain = (style: Style, name: unknown) =>
  style.opacity === "1" &&
  style["mix-blend-mode"] === "normal" &&
  style.clip === "auto" &&
  UNTRANSFORMED.every((property) => style[property] === "none") &&
  (!clipsContents(style, name) || RADII.every((radius) => style[radius] === "0px"));

/** Native refs, such as e12, whose whole box lies under solid content painted above it. */
export const occludedRefs = (shot: unknown, tree: string): ReadonlySet<string> => {
  const document = readDocument(shot);
  const occluded = new Set<string>();
  if (document === undefined) return occluded;
  const { parents, layouts, names } = document;
  const plainAbove: boolean[] = [];
  const clipAbove: Array<PaintRect | undefined> = [];
  for (let node = 0; node < parents.length; node++) {
    const parent = parents[node] ?? -1;
    const layout = layouts.get(parent);
    plainAbove[node] =
      parent < 0 ||
      ((plainAbove[parent] ?? false) && (!layout || isPlain(layout.style, names[parent])));
    clipAbove[node] =
      layout && clipsContents(layout.style, names[parent])
        ? intersect(layout.padding, clipAbove[parent])
        : clipAbove[parent];
  }
  const covers: Array<{
    readonly node: number;
    readonly rect: PaintRect;
    readonly paintOrder: number;
  }> = [];
  const byBox = new Map<string, number[]>();
  for (const [node, { box, bounds, paintOrder, style }] of layouts) {
    const key = box.map(Math.round).join(",");
    byBox.set(key, [...(byBox.get(key) ?? []), node]);
    const solid =
      (plainAbove[node] ?? false) &&
      isPlain(style, names[node]) &&
      /^rgb\(/.test(style["background-color"]) &&
      style.visibility === "visible" &&
      style["background-clip"] === "border-box" &&
      RADII.every((radius) => style[radius] === "0px");
    const rect = intersect(bounds, clipAbove[node]);
    if (solid && rect.x2 > rect.x1 && rect.y2 > rect.y1) covers.push({ node, rect, paintOrder });
  }
  for (const [, ref, x, y, width, height] of tree.matchAll(
    /\[ref=(e\d+)\][^\n]*?\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/g,
  )) {
    const candidates = byBox.get(`${x},${y},${width},${height}`) ?? [];
    const painted = candidates.flatMap((node) => layouts.get(node) ?? []);
    if (ref === undefined || painted.length === 0) continue;
    const first = Math.min(...candidates);
    const top = Math.max(...painted.map((layout) => layout.paintOrder));
    const enclosure = painted.reduce<PaintRect>(
      (all, { bounds }) => ({
        x1: Math.min(all.x1, bounds.x1),
        y1: Math.min(all.y1, bounds.y1),
        x2: Math.max(all.x2, bounds.x2),
        y2: Math.max(all.y2, bounds.y2),
      }),
      { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
    );
    const descends = (node: number) => {
      for (let at = parents[node] ?? -1; at >= first; at = parents[at] ?? -1)
        if (candidates.includes(at)) return true;
      return false;
    };
    const union = new RectUnion();
    for (const cover of covers)
      if (cover.paintOrder > top && overlaps(cover.rect, enclosure) && !descends(cover.node))
        union.add(cover.rect);
    if (union.contains(enclosure)) occluded.add(ref);
  }
  return occluded;
};

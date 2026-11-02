/**
 * Chooses where a click lands from CDP geometry, and judges the hit test and toggle around it.
 * Adapted from browser-use's click path, which treats a failed hit test as unoccluded and falls
 * back to a script click; every doubt here refuses with nothing sent instead.
 */

export type Point = { readonly x: number; readonly y: number };
export type Rect = Point & { readonly width: number; readonly height: number };
/** Eight numbers, x1,y1 … x4,y4, as DOM.getContentQuads returns them. */
export type Quad = ReadonlyArray<number>;

/**
 * An iframe holding the next frame, outermost first: its content box in its containing document's
 * page coordinates and that document's scroll. Set `unproven` for any mapping the caller has not
 * established (an out-of-process frame, scale, rotation, zoom, border offsets).
 */
export type FrameLink = {
  readonly bounds: Rect;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly unproven?: boolean;
};

export type ClickPointResult =
  | { readonly ok: true; readonly point: Point }
  | {
      readonly ok: false;
      readonly reason: "oopif_transform_unproven" | "invalid_geometry" | "no_visible_area";
      readonly nothingSent: true;
    };

export type HitTest = {
  readonly backendNodeId: number;
  readonly hitMatchesTargetOrDescendant: boolean;
  readonly hitIsAssociatedLabelOrControl?: boolean;
  readonly hitTestError?: string;
};

export type OcclusionVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "unsupported";
      readonly message: string;
      readonly detail: { readonly kind: "occluded_refused" };
      readonly nothingSent: true;
    };

type Box = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** A sliver under one CSS pixel cannot take a reliable click. */
const MIN_VISIBLE_AREA = 1;

const OCCLUDED_MESSAGE =
  "Something else may receive this click: the target's spot is covered or could not be hit-tested. Nothing was clicked.";

const refuse = (reason: Extract<ClickPointResult, { ok: false }>["reason"]): ClickPointResult => ({
  ok: false,
  reason,
  nothingSent: true,
});

const isFinite = (...values: ReadonlyArray<number>) => values.every(Number.isFinite);

const isPositiveRect = (rect: Rect) =>
  isFinite(rect.x, rect.y, rect.width, rect.height) && rect.width > 0 && rect.height > 0;

const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const area = (polygon: ReadonlyArray<Point>) =>
  Math.abs(
    polygon.reduce((sum, p, i) => {
      const next = polygon[(i + 1) % polygon.length] ?? p;
      return sum + p.x * next.y - next.x * p.y;
    }, 0),
  ) / 2;

/** A convex quad with area; malformed, self-intersecting and flat quads are null. */
const toConvexQuad = (quad: Quad): ReadonlyArray<Point> | null => {
  if (quad.length !== 8) return null;
  const points = [0, 2, 4, 6].map((i) => ({
    x: quad[i] ?? Number.NaN,
    y: quad[i + 1] ?? Number.NaN,
  }));
  if (!points.every((p) => isFinite(p.x, p.y))) return null;
  const turns = points.map((p, i) => cross(p, points[(i + 1) % 4] ?? p, points[(i + 2) % 4] ?? p));
  const convex = turns.every((t) => t >= 0) || turns.every((t) => t <= 0);
  return convex && area(points) > 0 ? points : null;
};

const rectQuad = (rect: Rect): ReadonlyArray<Point> => [
  { x: rect.x, y: rect.y },
  { x: rect.x + rect.width, y: rect.y },
  { x: rect.x + rect.width, y: rect.y + rect.height },
  { x: rect.x, y: rect.y + rect.height },
];

/** Sutherland-Hodgman against each side of an axis-aligned box. */
const clipToBox = (polygon: ReadonlyArray<Point>, box: Box): ReadonlyArray<Point> => {
  const sides: ReadonlyArray<{
    inside: (p: Point) => boolean;
    cut: (a: Point, b: Point) => Point;
  }> = [
    { inside: (p) => p.x >= box.left, cut: (a, b) => atX(a, b, box.left) },
    { inside: (p) => p.x <= box.right, cut: (a, b) => atX(a, b, box.right) },
    { inside: (p) => p.y >= box.top, cut: (a, b) => atY(a, b, box.top) },
    { inside: (p) => p.y <= box.bottom, cut: (a, b) => atY(a, b, box.bottom) },
  ];
  return sides.reduce<ReadonlyArray<Point>>(
    (input, side) =>
      input.flatMap((current, i) => {
        const previous = input[(i + input.length - 1) % input.length] ?? current;
        if (side.inside(current)) {
          return side.inside(previous) ? [current] : [side.cut(previous, current), current];
        }
        return side.inside(previous) ? [side.cut(previous, current)] : [];
      }),
    polygon,
  );
};

const atX = (a: Point, b: Point, x: number): Point => ({
  x,
  y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x),
});
const atY = (a: Point, b: Point, y: number): Point => ({
  x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y),
  y,
});

/** Inside a convex polygon, so already within the visible part's bounds. */
const vertexAverage = (polygon: ReadonlyArray<Point>): Point => {
  const distinct = polygon.filter((p, i) => {
    const next = polygon[(i + 1) % polygon.length] ?? p;
    return polygon.length === 1 || p.x !== next.x || p.y !== next.y;
  });
  return {
    x: distinct.reduce((sum, p) => sum + p.x, 0) / distinct.length,
    y: distinct.reduce((sum, p) => sum + p.y, 0) / distinct.length,
  };
};

/**
 * The top-level viewport point for a click on the target, from its content quads in its own frame's
 * viewport coordinates, or its box when no quad is usable. The most visible quad wins.
 */
export const selectClickPoint = (input: {
  readonly quads?: ReadonlyArray<Quad>;
  readonly box?: Rect;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frames?: ReadonlyArray<FrameLink>;
}): ClickPointResult => {
  const frames = input.frames ?? [];
  if (frames.some((frame) => frame.unproven === true)) return refuse("oopif_transform_unproven");
  const { width, height } = input.viewport;
  if (!isFinite(width, height) || width <= 0 || height <= 0) return refuse("invalid_geometry");

  let clip: Box = { left: 0, top: 0, right: width, bottom: height };
  let offset: Point = { x: 0, y: 0 };
  for (const { bounds, scrollX, scrollY } of frames) {
    if (!isPositiveRect(bounds) || !isFinite(scrollX, scrollY)) return refuse("invalid_geometry");
    offset = { x: offset.x + bounds.x - scrollX, y: offset.y + bounds.y - scrollY };
    clip = intersect(clip, {
      left: offset.x,
      top: offset.y,
      right: offset.x + bounds.width,
      bottom: offset.y + bounds.height,
    });
  }

  const quads = (input.quads ?? [])
    .map(toConvexQuad)
    .filter((quad): quad is ReadonlyArray<Point> => quad !== null);
  const candidates =
    quads.length > 0 ? quads : input.box && isPositiveRect(input.box) ? [rectQuad(input.box)] : [];
  if (candidates.length === 0) return refuse("invalid_geometry");
  if (clip.right <= clip.left || clip.bottom <= clip.top) return refuse("no_visible_area");

  let best: { readonly visible: ReadonlyArray<Point>; readonly area: number } | null = null;
  for (const candidate of candidates) {
    const placed = candidate.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
    const visible = clipToBox(placed, clip);
    const visibleArea = visible.length >= 3 ? area(visible) : 0;
    if (visibleArea > (best?.area ?? 0)) best = { visible, area: visibleArea };
  }
  if (!best || best.area < MIN_VISIBLE_AREA) return refuse("no_visible_area");
  return { ok: true, point: vertexAverage(best.visible) };
};

/** Clicks only when the hit test proved the target, or its label or control, receives the point. */
export const classifyOcclusionHitTest = (target: HitTest): OcclusionVerdict =>
  target.hitTestError === undefined &&
  (target.hitMatchesTargetOrDescendant || target.hitIsAssociatedLabelOrControl === true)
    ? { ok: true }
    : {
        ok: false,
        code: "unsupported",
        message: OCCLUDED_MESSAGE,
        detail: { kind: "occluded_refused" },
        nothingSent: true,
      };

/** A toggle is verified only by a read state that changed; an unverified one is never clicked again. */
export const evaluateTogglePostcondition = (
  beforeChecked: boolean | undefined,
  afterChecked: boolean | undefined,
): "toggle_verified" | "toggle_unverified" =>
  beforeChecked !== undefined && afterChecked !== undefined && beforeChecked !== afterChecked
    ? "toggle_verified"
    : "toggle_unverified";

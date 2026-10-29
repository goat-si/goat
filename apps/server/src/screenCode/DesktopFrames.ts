/**
 * Where a desktop element sits: element frames from a tree read, a window's bounds from
 * list_windows or a screenshot, and an element's center as a fraction of its window for the cursor.
 */
import type { ComputerUseOverlayPoint } from "@goat/contracts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const frameOf = (entry: Record<string, unknown> | undefined) => {
  const frame = object(entry?.frame);
  return frame && finite(frame.x) && finite(frame.y) && finite(frame.w) && finite(frame.h)
    ? { x: frame.x, y: frame.y, w: frame.w, h: frame.h }
    : undefined;
};
/**
 * Each framed element's center as a fraction of its window, by driver token. Frames share the
 * driver's screen space; get_window_state returns window_bounds only beside a screenshot, so the
 * window is the root the element's parents reach when that root is a window, else the bounds
 * list_windows gave. A center outside the window, such as a menu bar item's, gives no point.
 */
export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};
/** A framed element and, when the tree indexed it, the window it sits in. */
export type Placed = { readonly frame: Rect; readonly window?: Rect };
/** Where a parent chain ends and after how many parent steps; Infinity for a cycle. */
type Chain = { readonly steps: number; readonly root: Record<string, unknown> | undefined };
/** A root more than this many parent steps above an element is not looked for. */
const MAX_PARENT_STEPS = 64;
/**
 * Each framed element by driver token, with its window when the tree has one. Frames share the
 * driver's screen space; the fraction is taken at action time (aimOf), against the window's
 * bounds as they are then when the tree left the window out.
 */
export const elementFrames = (entries: readonly Record<string, unknown>[]) => {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const entry of entries) {
    const index = natural(entry.element_index);
    if (index !== undefined) byIndex.set(index, entry);
  }
  // Each index's chain is walked once and shared by every element below it.
  const chains = new Map<number, Chain>();
  const chainOf = (start: number): Chain => {
    const path: number[] = [];
    const onPath = new Set<number>();
    let next = start;
    let tail: Chain;
    for (;;) {
      const known = chains.get(next);
      if (known !== undefined) {
        tail = known;
        break;
      }
      if (onPath.has(next)) {
        tail = { steps: Infinity, root: undefined };
        break;
      }
      const node = byIndex.get(next);
      const parent = node === undefined ? undefined : natural(node.parent_index);
      if (parent === undefined) {
        tail = { steps: 0, root: node };
        chains.set(next, tail);
        break;
      }
      path.push(next);
      onPath.add(next);
      next = parent;
    }
    for (let at = path.length - 1; at >= 0; at--) {
      tail = { steps: tail.steps + 1, root: tail.root };
      chains.set(path[at] ?? -1, tail);
    }
    return tail;
  };
  const placed = new Map<string, Placed>();
  for (const entry of entries) {
    const token = string(entry.element_token);
    const frame = frameOf(entry);
    if (!token || !frame) continue;
    // The element itself is the first step; its parent is looked up by index like every other.
    const parent = natural(entry.parent_index);
    const chain = parent === undefined ? undefined : chainOf(parent);
    const root =
      chain === undefined ? entry : chain.steps < MAX_PARENT_STEPS ? chain.root : undefined;
    const role = string(root?.role)?.toLowerCase() ?? "";
    const window = WINDOW_ROLES.has(role) ? frameOf(root) : undefined;
    placed.set(token, window ? { frame, window } : { frame });
  }
  return placed;
};
export const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/**
 * Where agent-facing frames are measured from: the read's one top-level window, when it has a
 * positive frame. A second top-level window, even one with the same bounds, cannot be told apart
 * from the bound one, so then there is none.
 */
export const windowOrigin = (entries: readonly Record<string, unknown>[]): Rect | undefined => {
  let origin: Rect | undefined;
  for (const entry of entries) {
    if (natural(entry.parent_index) !== undefined) continue;
    if (!WINDOW_ROLES.has(string(entry.role)?.toLowerCase() ?? "")) continue;
    const frame = frameOf(entry);
    if (origin || !frame || frame.w <= 0 || frame.h <= 0) return undefined;
    origin = frame;
  }
  return origin;
};
/**
 * An element's center as a fraction of its window; a center outside the window gives none. A
 * tree that left its window out is measured against the bounds held when it was read, while no
 * screenshot has shown them wrong: the host cannot tell a move before the read from one after.
 */
export const aimOf = (
  placed: Placed | undefined,
  basis: Rect | undefined,
): ComputerUseOverlayPoint | undefined => {
  const window = placed?.window ?? basis;
  if (!placed || !window || window.w <= 0 || window.h <= 0) return undefined;
  const fx = (placed.frame.x + placed.frame.w / 2 - window.x) / window.w;
  const fy = (placed.frame.y + placed.frame.h / 2 - window.y) / window.h;
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : undefined;
};
/** Window bounds as list_windows and screenshots report them, in the shape element frames use. */
export const boundsOf = (value: unknown) => {
  const bounds = object(value);
  return bounds &&
    finite(bounds.x) &&
    finite(bounds.y) &&
    finite(bounds.width) &&
    finite(bounds.height)
    ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
    : undefined;
};
/** Top-level roots as the driver names them, lowercased: macOS, Windows, then Linux AT-SPI. */
const WINDOW_ROLES: ReadonlySet<string> = new Set([
  "axwindow",
  "window",
  "frame",
  "dialog",
  "alert",
  "file chooser",
]);

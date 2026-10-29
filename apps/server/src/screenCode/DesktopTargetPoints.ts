// @effect-diagnostics nodeBuiltinImport:off - Screenshot and region IDs are opaque UUIDs.
/**
 * Desktop pointer coordinate resolution: converts [x, y] screenshot pixels (using the screenshot's
 * actual region-to-pixel ratio, even when downscaled), { window: [x, y] } window points, and
 * element drag endpoints into window points with a validated window_basis.
 */
import * as NodeCrypto from "node:crypto";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenImage,
  ScreenImageMetadata,
  ScreenRunError,
} from "@goat/contracts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";
import { fail } from "./DesktopDriverReplies.ts";
import { sameRect, type Placed, type Rect } from "./DesktopFrames.ts";

export interface ScreenshotBasis {
  readonly regionId: string;
  readonly basis: Rect;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scale: number;
}

const RESTARTED_POINTS = "The driver restarted; take a new screenshot before using [x, y] pixels.";
const MOVED_WINDOW =
  "The window moved or resized since it was read; observe again and use the new { window: [x, y] } window points (or [x, y] pixels from a new screenshot).";
const MOVED_DRAG = "The window moved since it was read; observe it again.";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export interface PointResolutionState {
  readonly pointsStale?: "input" | "restart";
  readonly frames?: ReadonlyMap<string, Placed>;
  readonly framesBasis?: Rect;
  readonly windowBounds?: Rect;
  readonly screenshots?: ReadonlyMap<string, ScreenshotBasis>;
  readonly latestScreenshot?: ScreenshotBasis;
  readonly resolveToken: (element: Record<string, unknown>) => string | undefined;
}

const resolveEndpoint = (
  end: Record<string, unknown>,
  state: PointResolutionState,
):
  | { readonly ok: true; readonly x: number; readonly y: number; readonly basis: Rect }
  | { readonly ok: false; readonly error: ScreenRunError } => {
  const element = object(end.elementRef);
  if (element !== undefined) {
    const token = state.resolveToken(element);
    if (!token) return { ok: false, error: fail("stale_reference") };
    const placed = state.frames?.get(token);
    const basis = state.framesBasis;
    if (!placed || !basis || basis.w <= 0 || basis.h <= 0)
      return { ok: false, error: fail("stale_reference", MOVED_DRAG) };
    return {
      ok: true,
      x: placed.frame.x + placed.frame.w / 2 - basis.x,
      y: placed.frame.y + placed.frame.h / 2 - basis.y,
      basis,
    };
  }
  const x = end.x;
  const y = end.y;
  if (!finite(x) || !finite(y)) return { ok: false, error: fail("invalid_argument") };
  if (end.coordinate_space === "window_points") {
    const basis = state.framesBasis ?? state.windowBounds;
    if (!basis || basis.w <= 0 || basis.h <= 0)
      return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
    return { ok: true, x, y, basis };
  }
  if (state.pointsStale === "restart")
    return { ok: false, error: fail("stale_reference", RESTARTED_POINTS) };
  const regionId = string(end.regionId);
  const shot = (regionId ? state.screenshots?.get(regionId) : undefined) ?? state.latestScreenshot;
  if (!shot || shot.pixelWidth <= 0 || shot.pixelHeight <= 0)
    return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
  return {
    ok: true,
    x: (x * shot.basis.w) / shot.pixelWidth,
    y: (y * shot.basis.h) / shot.pixelHeight,
    basis: shot.basis,
  };
};

/**
 * Resolves pointer coordinates on forwarded desktop input arguments, returning the window point
 * used (when converted to window_points) or a pre-dispatch refusal error.
 */
export const applyDesktopPointerArgs = (
  method: ScreenHostCall["method"],
  args: Record<string, unknown>,
  forwarded: Record<string, unknown>,
  state: PointResolutionState,
):
  | { readonly ok: true; readonly windowPoint?: { readonly x: number; readonly y: number } }
  | { readonly ok: false; readonly error: ScreenRunError } => {
  delete forwarded.regionId;
  delete forwarded.fromEnd;
  delete forwarded.toEnd;
  delete forwarded.scrollCenter;

  if (method === "drag" && (args.fromEnd !== undefined || args.toEnd !== undefined)) {
    const fromObj = object(args.fromEnd);
    const toObj = object(args.toEnd);
    if (!fromObj || !toObj) return { ok: false, error: fail("invalid_argument") };
    const fromRes = resolveEndpoint(fromObj, state);
    if (!fromRes.ok) return fromRes;
    const toRes = resolveEndpoint(toObj, state);
    if (!toRes.ok) return toRes;
    if (!sameRect(fromRes.basis, toRes.basis))
      return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
    forwarded.from_x = fromRes.x;
    forwarded.from_y = fromRes.y;
    forwarded.to_x = toRes.x;
    forwarded.to_y = toRes.y;
    forwarded.coordinate_space = "window_points";
    forwarded.window_basis = fromRes.basis;
    return { ok: true, windowPoint: { x: toRes.x, y: toRes.y } };
  }

  if (method === "scroll" && args.scrollCenter === true) {
    const basis = state.framesBasis ?? state.windowBounds;
    if (!basis || basis.w <= 0 || basis.h <= 0)
      return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
    const cx = Math.floor(basis.w / 2);
    const cy = Math.floor(basis.h / 2);
    forwarded.x = cx;
    forwarded.y = cy;
    forwarded.coordinate_space = "window_points";
    forwarded.window_basis = basis;
    return { ok: true, windowPoint: { x: cx, y: cy } };
  }

  const hasXY = finite(args.x) && finite(args.y);
  const hasDragXY =
    finite(args.from_x) && finite(args.from_y) && finite(args.to_x) && finite(args.to_y);
  if (!hasXY && !hasDragXY) return { ok: true };

  if (args.coordinate_space === "window_points") {
    const basis = state.framesBasis ?? state.windowBounds;
    if (!basis || basis.w <= 0 || basis.h <= 0)
      return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
    forwarded.coordinate_space = "window_points";
    forwarded.window_basis = basis;
    return {
      ok: true,
      ...(hasXY ? { windowPoint: { x: args.x as number, y: args.y as number } } : {}),
    };
  }

  if (state.pointsStale === "restart")
    return { ok: false, error: fail("stale_reference", RESTARTED_POINTS) };

  const regionId = string(args.regionId);
  if (regionId !== undefined) {
    const shot = state.screenshots?.get(regionId) ?? state.latestScreenshot;
    if (!shot || shot.pixelWidth <= 0 || shot.pixelHeight <= 0)
      return { ok: false, error: fail("stale_reference", MOVED_WINDOW) };
    if (hasXY) {
      const wx = ((args.x as number) * shot.basis.w) / shot.pixelWidth;
      const wy = ((args.y as number) * shot.basis.h) / shot.pixelHeight;
      forwarded.x = wx;
      forwarded.y = wy;
      forwarded.coordinate_space = "window_points";
      forwarded.window_basis = shot.basis;
      return { ok: true, windowPoint: { x: wx, y: wy } };
    }
    if (hasDragXY) {
      const fx = ((args.from_x as number) * shot.basis.w) / shot.pixelWidth;
      const fy = ((args.from_y as number) * shot.basis.h) / shot.pixelHeight;
      const tx = ((args.to_x as number) * shot.basis.w) / shot.pixelWidth;
      const ty = ((args.to_y as number) * shot.basis.h) / shot.pixelHeight;
      forwarded.from_x = fx;
      forwarded.from_y = fy;
      forwarded.to_x = tx;
      forwarded.to_y = ty;
      forwarded.coordinate_space = "window_points";
      forwarded.window_basis = shot.basis;
      return { ok: true, windowPoint: { x: tx, y: ty } };
    }
  }

  return { ok: true };
};

/** Attaches window-point coordinates and hit metadata to a pointer action's result value. */
export const annotatePointerResult = (
  result: ScreenHostDispatchResult,
  windowPoint: { readonly x: number; readonly y: number } | undefined,
): ScreenHostDispatchResult => {
  if (windowPoint === undefined) return result;
  const current = object(result.value) ?? {};
  return {
    ...result,
    value: {
      ...current,
      point: current.point ?? {
        x: windowPoint.x,
        y: windowPoint.y,
        unit: "window_points",
      },
      hit: "hit" in current ? current.hit : null,
    },
  };
};

/** The window basis held by a tree read: its root window frame when present, else known bounds. */
export const treeWindowBasis = (
  frames: ReadonlyMap<string, Placed>,
  windowBounds: Rect | undefined,
): Rect | undefined => {
  for (const placed of frames.values()) if (placed.window) return placed.window;
  return windowBounds;
};

/** Builds screenshot metadata, image payload and window-point basis from a driver capture reply. */
export const buildScreenshotCapture = (input: {
  readonly callId: number;
  readonly targetId: string;
  readonly observationId: string;
  readonly state: Record<string, unknown>;
  readonly imagePart: ComputerUsePrimitiveReply["image"];
  readonly width: number | undefined;
  readonly height: number | undefined;
}):
  | {
      readonly metadata: ScreenImageMetadata;
      readonly image: ScreenImage;
      readonly shotBasis: ScreenshotBasis;
    }
  | undefined => {
  const { callId, targetId, observationId, state, imagePart, width, height } = input;
  if (!imagePart || !width || !height || imagePart.width !== width || imagePart.height !== height)
    return undefined;
  const bounds = object(state.window_bounds);
  const regionWidth = typeof bounds?.width === "number" && bounds.width > 0 ? bounds.width : width;
  const regionHeight =
    typeof bounds?.height === "number" && bounds.height > 0 ? bounds.height : height;
  const mimeType =
    imagePart.mimeType === "image/jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
  const metadata: ScreenImageMetadata = {
    imageRef: NodeCrypto.randomUUID(),
    callId,
    targetId,
    observationId,
    regionId: NodeCrypto.randomUUID(),
    region: {
      kind: "window",
      x: typeof bounds?.x === "number" ? bounds.x : 0,
      y: typeof bounds?.y === "number" ? bounds.y : 0,
      width: regionWidth,
      height: regionHeight,
    },
    pixelWidth: width,
    pixelHeight: height,
    scale:
      typeof state.screenshot_scale === "number" && state.screenshot_scale > 0
        ? state.screenshot_scale
        : 1,
    pointsPerPixel: { x: regionWidth / width, y: regionHeight / height },
    mimeType,
  };
  const shotBasis: ScreenshotBasis = {
    regionId: metadata.regionId,
    basis: {
      x: metadata.region.x,
      y: metadata.region.y,
      w: metadata.region.width,
      h: metadata.region.height,
    },
    pixelWidth: width,
    pixelHeight: height,
    scale: metadata.scale,
  };
  return {
    metadata,
    image: { ...metadata, bytes: imagePart.bytes },
    shotBasis,
  };
};

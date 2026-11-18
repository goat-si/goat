import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindowBounds from "./DesktopWindowBounds.ts";

type DisplayBounds = DesktopWindowBounds.DisplayBounds;

export const MIN_MAIN_WINDOW_WIDTH = DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.width;
export const MIN_MAIN_WINDOW_HEIGHT = DesktopAppSettings.MIN_MAIN_WINDOW_SIZE.height;

function getOverlapArea(left: DisplayBounds, right: DisplayBounds): number {
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return overlapWidth * overlapHeight;
}

function getAxisGap(
  firstStart: number,
  firstSize: number,
  secondStart: number,
  secondSize: number,
): number {
  if (firstStart + firstSize < secondStart) {
    return secondStart - (firstStart + firstSize);
  }
  if (secondStart + secondSize < firstStart) {
    return firstStart - (secondStart + secondSize);
  }
  return 0;
}

function getDisplayDistanceSquared(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): number {
  const dx = getAxisGap(windowBounds.x, windowBounds.width, displayBounds.x, displayBounds.width);
  const dy = getAxisGap(windowBounds.y, windowBounds.height, displayBounds.y, displayBounds.height);
  return dx * dx + dy * dy;
}

function clampDimension(value: number, minimum: number, available: number): number {
  const maximum = Math.max(minimum, Math.floor(available));
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function clampCoordinate(value: number, start: number, available: number, size: number): number {
  const minimum = Math.round(start);
  const maximum = Math.max(minimum, Math.round(start + available) - size);
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function clampWindowBoundsToDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): DesktopAppSettings.DesktopWindowBounds {
  const width = clampDimension(windowBounds.width, MIN_MAIN_WINDOW_WIDTH, displayBounds.width);
  const height = clampDimension(windowBounds.height, MIN_MAIN_WINDOW_HEIGHT, displayBounds.height);
  return {
    x: clampCoordinate(windowBounds.x, displayBounds.x, displayBounds.width, width),
    y: clampCoordinate(windowBounds.y, displayBounds.y, displayBounds.height, height),
    width,
    height,
  };
}

export function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function displayMatching(
  bounds: DisplayBounds,
  displays: readonly DisplayBounds[],
): DisplayBounds | undefined {
  let match: DisplayBounds | undefined;
  let matchArea = 0;
  for (const display of displays) {
    const area = getOverlapArea(bounds, display);
    if (area > matchArea) {
      match = display;
      matchArea = area;
    }
  }
  return match;
}

// Normal bounds of a maximized window can sit on, or straddle into, another display than the window.
export function normalBoundsOnWindowDisplay(
  normalBounds: DisplayBounds,
  windowBounds: DisplayBounds,
  displays: readonly DisplayBounds[],
): DisplayBounds {
  const target = displayMatching(windowBounds, displays);
  if (target === undefined || DesktopWindowBounds.fitsWithinDisplays(normalBounds, [target])) {
    return normalBounds;
  }
  const source = displayMatching(normalBounds, displays) ?? target;
  const width = Math.min(normalBounds.width, target.width);
  const height = Math.min(normalBounds.height, target.height);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  return {
    x: clamp(target.x + normalBounds.x - source.x, target.x, target.x + target.width - width),
    y: clamp(target.y + normalBounds.y - source.y, target.y, target.y + target.height - height),
    width,
    height,
  };
}

function selectRecoveryDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  [first, ...remaining]: readonly [DisplayBounds, ...DisplayBounds[]],
): DisplayBounds {
  let selected = first;
  let bestOverlapArea = getOverlapArea(windowBounds, selected);
  let bestDistanceSquared = getDisplayDistanceSquared(windowBounds, selected);

  for (const candidate of remaining) {
    const overlapArea = getOverlapArea(windowBounds, candidate);
    const distanceSquared = getDisplayDistanceSquared(windowBounds, candidate);
    if (
      overlapArea > bestOverlapArea ||
      (overlapArea === bestOverlapArea && distanceSquared < bestDistanceSquared)
    ) {
      selected = candidate;
      bestOverlapArea = overlapArea;
      bestDistanceSquared = distanceSquared;
    }
  }

  return selected;
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  const validDisplays = displays.filter((display) => display.width > 0 && display.height > 0);
  const [first, ...remaining] = validDisplays;
  if (persistedBounds === null || first === undefined) {
    return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
  }
  if (DesktopWindowBounds.fitsWithinDisplays(persistedBounds, validDisplays)) {
    return persistedBounds;
  }
  return clampWindowBoundsToDisplay(
    persistedBounds,
    selectRecoveryDisplay(persistedBounds, [first, ...remaining]),
  );
}

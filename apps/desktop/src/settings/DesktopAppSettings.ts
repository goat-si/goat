// Subset of GOAT v1 apps/desktop/src/settings/DesktopAppSettings.ts: the main window size constants
// and the saved window state (v1 keeps mainWindowBounds / mainWindowMaximized in its desktop
// settings file; GOAT 2 has no other desktop settings yet, so they get their own small file).
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const MIN_MAIN_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const;
export interface DesktopWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;

export interface MainWindowState {
  readonly mainWindowBounds: DesktopWindowBounds | null;
  readonly mainWindowMaximized: boolean;
}

const isInt = (value: unknown): value is number => Number.isInteger(value);

/** v1 DesktopWindowBoundsSchema: integer bounds, at least the minimum size. */
function decodeBounds(value: unknown): DesktopWindowBounds | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!isInt(x) || !isInt(y) || !isInt(width) || !isInt(height)) return null;
  if (width < MIN_MAIN_WINDOW_SIZE.width || height < MIN_MAIN_WINDOW_SIZE.height) return null;
  return { x, y, width, height };
}

export function readMainWindowState(file: string): MainWindowState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      mainWindowBounds: decodeBounds(raw.mainWindowBounds),
      mainWindowMaximized: raw.mainWindowMaximized === true,
    };
  } catch {
    return { mainWindowBounds: null, mainWindowMaximized: false };
  }
}

export function writeMainWindowState(file: string, state: MainWindowState): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, file);
}

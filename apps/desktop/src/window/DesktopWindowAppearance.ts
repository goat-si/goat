import type * as Electron from "electron";

const TITLEBAR_HEIGHT = 40;
// Matches --workspace-topbar-height in apps/web/src/index.css. Native macOS
// buttons are 14 points tall and do not scale with the renderer's zoom.
// GOAT 2: 40 (docs/DECISIONS.md "Top bar 40px", supersedes v1's 52).
export const MACOS_WORKSPACE_TOPBAR_HEIGHT = 40;
export const MACOS_WINDOW_BUTTON_RADIUS = 7;

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

export function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#171717" : "#ffffff";
}

export function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

// Lifted from v1 apps/desktop/src/window/DesktopWindow.ts (syncMacosWindowButtons): keeps the
// buttons centred in the top bar when the app zoom changes.
export function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

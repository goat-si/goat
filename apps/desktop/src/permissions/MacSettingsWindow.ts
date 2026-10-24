// @effect-diagnostics nodeBuiltinImport:off -- This native boundary keeps one JXA process open while the permission helper tracks System Settings.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

const SettingsWindow = Schema.NullOr(
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
    frontmost: Schema.Boolean,
  }),
);
export type SettingsWindow = typeof SettingsWindow.Type;
const decodeSettingsWindow = Schema.decodeUnknownSync(Schema.fromJsonString(SettingsWindow));

// Window bounds and owner PIDs are available before Screen Recording is granted.
// Use the bundle identifier rather than the localized app/window title. A single
// process avoids launching osascript repeatedly while the user moves Settings.
const SETTINGS_WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
  let previous = "";
  while (true) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.systempreferences");
    let result = null;
    if (apps.count > 0) {
      const pid = apps.objectAtIndex(0).processIdentifier;
      const list = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        $.kCGNullWindowID
      );
      if (list) {
        $.CFMakeCollectable(list);
        const count = $.CFArrayGetCount(list);
        // The list runs front to back, so the first normal window belongs to the frontmost app.
        // NSWorkspace's frontmostApplication would stay frozen here: this loop never runs the
        // run loop that delivers its updates.
        let frontPid = null;
        for (let i = 0; i < count; i++) {
          const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
          if (frontPid === null && w.objectForKey("kCGWindowLayer").js === 0) frontPid = w.objectForKey("kCGWindowOwnerPID").js;
          if (w.objectForKey("kCGWindowOwnerPID").js !== pid || w.objectForKey("kCGWindowLayer").js !== 0) continue;
          const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
          if (b.Width < 500 || b.Height < 350) continue;
          result = { x: b.X, y: b.Y, width: b.Width, height: b.Height, frontmost: frontPid === pid };
          break;
        }
      }
    }
    const line = JSON.stringify(result);
    if (line !== previous) {
      const data = $(line + "\\n").dataUsingEncoding($.NSUTF8StringEncoding);
      $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
      previous = line;
    }
    $.NSThread.sleepForTimeInterval(result && result.frontmost ? 0.5 : 1);
  }
}`;

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 140;
const GAP = 8;
const SIDEBAR_WIDTH = 216;
const TOOLBAR_HEIGHT = 52;

/**
 * Where the drag panel goes beside System Settings: below the window, else to its right, else to
 * its left, within the display. The list's last rows and its + and − buttons stay uncovered,
 * because removing a stale entry is part of the guidance; with no room outside, the panel sits
 * under the toolbar over the pane's description instead.
 */
export function settingsHelperBounds(
  settings: NonNullable<SettingsWindow>,
  workArea: Electron.Rectangle,
): Electron.Rectangle {
  const width = Math.min(PANEL_WIDTH, workArea.width);
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  const clampX = (x: number) => Math.min(Math.max(x, workArea.x), right - width);
  const clampY = (y: number) => Math.min(Math.max(y, workArea.y), bottom - PANEL_HEIGHT);
  const listCenter = settings.x + SIDEBAR_WIDTH + (settings.width - SIDEBAR_WIDTH) / 2;
  const place = (x: number, y: number, w = width): Electron.Rectangle => ({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: PANEL_HEIGHT,
  });
  const below = settings.y + settings.height + GAP;
  if (below + PANEL_HEIGHT <= bottom) return place(clampX(listCenter - width / 2), below);
  const besideY = clampY(settings.y + settings.height - PANEL_HEIGHT);
  const toRight = settings.x + settings.width + GAP;
  if (toRight + width <= right) return place(toRight, besideY);
  const toLeft = settings.x - GAP - width;
  if (toLeft >= workArea.x) return place(toLeft, besideY);
  const inner = Math.min(width, settings.width - SIDEBAR_WIDTH - 2 * GAP);
  return place(listCenter - inner / 2, settings.y + TOOLBAR_HEIGHT, inner);
}

export function watchMacSettingsWindow(
  onChange: (window: SettingsWindow) => void,
  onUnavailable: () => void,
): () => void {
  const child = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", SETTINGS_WINDOW_SCRIPT],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let pending = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (closed) return;
      let settings: SettingsWindow;
      try {
        settings = decodeSettingsWindow(line);
      } catch {
        onUnavailable();
        continue;
      }
      onChange(settings);
    }
  });
  const onExit = () => {
    if (!closed) onUnavailable();
  };
  child.on("error", onExit);
  child.on("exit", onExit);
  return () => {
    closed = true;
    child.stdout.removeAllListeners("data");
    child.kill();
  };
}

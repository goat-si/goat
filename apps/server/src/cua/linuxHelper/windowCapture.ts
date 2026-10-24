import type { LinuxSession } from "./linuxSession.ts";

/**
 * Whether the image Cua Driver returns for a window holds only that window's pixels (#1328).
 * Pinned 0.37.0 takes it four ways:
 *
 * - X11: XShm/XGetImage on the window itself (capture.rs). That is the window's own pixmap only
 *   while a compositing manager redirects windows; without one, the obscured parts show
 *   whatever covers the window. When the app's own popup or dialog overlaps it, the driver
 *   captures that screen region instead and marks the answer `screenshot_composited`.
 * - XWayland: the same X11 path; Xwayland redirects every top-level window itself.
 * - Wayland on Hyprland: the toplevel's own export, and an error, never a crop, when that fails
 *   (wayland/hyprland.rs). The driver decides Hyprland from the environment it runs with, so the
 *   check reads that same environment.
 * - Any other Wayland compositor: a capture of the whole output cropped to the window's
 *   bounds, or a GNOME Shell helper whose per-window route falls back to that crop inside the
 *   driver whenever its version lookup fails (wayland/mod.rs:1047, :1103), so a passing check
 *   outside the driver cannot prove which route a capture took.
 *
 * Answers undefined when a capture is the window's own, or why it is not.
 */
export type WindowCaptureCheck = () => Promise<string | undefined>;

export const CROPPED_CAPTURE =
  "This Wayland desktop cannot capture one window by itself: Cua Driver would crop a capture of the whole screen, which can show other apps' windows. Screenshots are off here; app controls still work. Hyprland or an X11 session can show GOAT a single window.";
export const UNREDIRECTED_CAPTURE =
  "No compositing manager runs on this X display, so a window capture would show whatever covers the window, other apps included. Screenshots are off here; app controls still work. A desktop with a compositor (GNOME, KDE, or picom on other window managers) can show GOAT a single window.";
export const COMPOSITED_CAPTURE =
  "A popup or dialog is open over this window, so its screenshot would be taken from the screen and could show other apps. Observe it without a screenshot, or close the popup first.";

export function makeWindowCaptureCheck(deps: {
  readonly session: LinuxSession;
  /** Exactly the environment the driver runs with. */
  readonly driverEnvironment: Readonly<Record<string, string | undefined>>;
  /** Whether a compositing manager owns the X screen. */
  readonly compositing: () => Promise<boolean>;
}): WindowCaptureCheck {
  const { displayServer } = deps.session;
  if (displayServer === "xwayland") return async () => undefined;
  if (displayServer === "x11")
    return async () => ((await deps.compositing()) ? undefined : UNREDIRECTED_CAPTURE);
  const present = (name: string) => (deps.driverEnvironment[name] ?? "").trim() !== "";
  // The driver's own test: the Wayland backend on, a Hyprland instance, and not injecting.
  const hyprland =
    displayServer === "wayland" &&
    present("CUA_DRIVER_RS_ENABLE_WAYLAND") &&
    present("WAYLAND_DISPLAY") &&
    present("HYPRLAND_INSTANCE_SIGNATURE") &&
    !present("CUA_INJECT_SOCKET");
  return async () => (hyprland ? undefined : CROPPED_CAPTURE);
}

import type { LinuxSession } from "./linuxSession.ts";
import type { DriverShot, X11WindowCapture } from "./x11WindowCapture.ts";

/**
 * Where an agent's window screenshot comes from, so it holds only that window's pixels (#1328).
 *
 * - X11 and XWayland: the helper captures the window itself from its composite pixmap
 *   (x11WindowCapture.ts), which proves the pixels are the window's own or refuses. Pinned Cua
 *   Driver 0.37.0's own X11 capture reads the window's drawable, which shows whatever covers it
 *   when nothing redirects the window, and takes the screen region under a popup. The driver
 *   still takes its screenshot, and only its size is kept: its pointer tools need the scale of
 *   the last screenshot they read the window by.
 * - Wayland on Hyprland: the driver exports the toplevel itself, and errs rather than crop
 *   (wayland/hyprland.rs). It decides Hyprland from the environment it runs with, so this reads
 *   that same environment with the driver's own test.
 * - Any other Wayland compositor: the driver crops a capture of the whole output, or its GNOME
 *   Shell helper falls back to that crop inside the driver when its version lookup fails
 *   (wayland/mod.rs:1047, :1103). Nothing outside the driver can tell which route a capture took.
 */
export type CaptureRoute =
  | {
      readonly route: "own";
      readonly capture: (windowId: number, shot: DriverShot) => Promise<X11WindowCapture>;
    }
  | { readonly route: "driver" }
  | { readonly route: "refused"; readonly reason: string };

export const CROPPED_CAPTURE =
  "This Wayland desktop cannot capture one window by itself: Cua Driver would crop a capture of the whole screen, which can show other apps' windows. Screenshots are off here; app controls still work. Hyprland or an X11 session can show GOAT a single window.";

export function captureRoute(deps: {
  readonly session: LinuxSession;
  /** Exactly the environment the driver runs with. */
  readonly driverEnvironment: Readonly<Record<string, string | undefined>>;
  readonly captureX11: (windowId: number, shot: DriverShot) => Promise<X11WindowCapture>;
}): CaptureRoute {
  const { displayServer } = deps.session;
  if (displayServer === "x11" || displayServer === "xwayland")
    return { route: "own", capture: deps.captureX11 };
  return displayServer === "wayland"
    ? waylandCaptureRoute(deps.driverEnvironment)
    : { route: "refused", reason: CROPPED_CAPTURE };
}

/** Wayland without an X display: the driver's own export on Hyprland, refused anywhere else. */
export function waylandCaptureRoute(
  driverEnvironment: Readonly<Record<string, string | undefined>>,
): CaptureRoute {
  const present = (name: string) => (driverEnvironment[name] ?? "").trim() !== "";
  // The driver's own test: the Wayland backend on, a Hyprland instance, and not injecting.
  const hyprland =
    present("CUA_DRIVER_RS_ENABLE_WAYLAND") &&
    present("WAYLAND_DISPLAY") &&
    present("HYPRLAND_INSTANCE_SIGNATURE") &&
    !present("CUA_INJECT_SOCKET");
  return hyprland ? { route: "driver" } : { route: "refused", reason: CROPPED_CAPTURE };
}

/**
 * The size of the driver's screenshot of a window, and the window's own size when the driver
 * read it (window_bounds), so a window that changed size since is never matched by guesswork.
 */
export const driverShot = (structured: unknown): DriverShot | undefined => {
  const read = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const bounds = read(structured, "window_bounds");
  const numbers = [
    read(structured, "screenshot_width"),
    read(structured, "screenshot_height"),
    read(bounds, "width"),
    read(bounds, "height"),
  ];
  if (!numbers.every((value): value is number => typeof value === "number" && value > 0))
    return undefined;
  const [width = 0, height = 0, windowWidth = 0, windowHeight = 0] = numbers;
  return { width, height, windowWidth, windowHeight };
};

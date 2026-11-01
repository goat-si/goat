import { describe, expect, it } from "vite-plus/test";

import { detectLinuxSession, type LinuxSessionFacts } from "./linuxSession.ts";
import { captureRoute, CROPPED_CAPTURE } from "./windowCapture.ts";

const WAYLAND: LinuxSessionFacts = {
  display: undefined,
  waylandDisplay: "wayland-1",
  sessionBus: "unix:path=/run/user/1000/bus",
  currentDesktop: "Hyprland",
  gnomeShellMajor: null,
};

/** The route for a session, with the environment the helper would hand the driver. */
const route = (facts: LinuxSessionFacts, extra: Record<string, string> = {}) => {
  const session = detectLinuxSession(facts);
  return captureRoute({
    session,
    driverEnvironment: {
      WAYLAND_DISPLAY: facts.waylandDisplay,
      ...session.driverEnvironment,
      ...extra,
    },
    captureX11: async () => ({ refused: "not in this test" }),
  });
};

describe("where a Linux window screenshot comes from (#1328)", () => {
  it("X11 and XWayland windows are captured by the helper itself, never by the driver", () => {
    expect(route({ ...WAYLAND, display: ":0", waylandDisplay: undefined }).route).toBe("own");
    expect(route({ ...WAYLAND, display: ":0" }).route).toBe("own");
  });

  it("pure Wayland uses the driver's capture only where the driver itself sees Hyprland", () => {
    expect(route(WAYLAND, { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" }).route).toBe("driver");
    // A signature the driver is not given counts for nothing; inject mode routes it elsewhere.
    expect(route(WAYLAND)).toEqual({ route: "refused", reason: CROPPED_CAPTURE });
    expect(
      route(WAYLAND, { HYPRLAND_INSTANCE_SIGNATURE: "abc_123", CUA_INJECT_SOCKET: "/run/cua.sock" })
        .route,
    ).toBe("refused");
  });

  it("GNOME and every other Wayland compositor are refused, whatever helper is installed", () => {
    expect(route({ ...WAYLAND, currentDesktop: "GNOME", gnomeShellMajor: 46 }).route).toBe(
      "refused",
    );
    expect(route({ ...WAYLAND, currentDesktop: "sway" }).route).toBe("refused");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { detectLinuxSession, type LinuxSessionFacts } from "./linuxSession.ts";
import { CROPPED_CAPTURE, makeWindowCaptureCheck, UNREDIRECTED_CAPTURE } from "./windowCapture.ts";

const BUS = "unix:path=/run/user/1000/bus";
const WAYLAND: LinuxSessionFacts = {
  display: undefined,
  waylandDisplay: "wayland-1",
  sessionBus: BUS,
  currentDesktop: "Hyprland",
  gnomeShellMajor: null,
};

/** The check for a session, with the environment the helper would hand the driver. */
function check(facts: LinuxSessionFacts, extra: Record<string, string> = {}, compositing = true) {
  const session = detectLinuxSession(facts);
  let asked = 0;
  const windowCapture = makeWindowCaptureCheck({
    session,
    driverEnvironment: {
      WAYLAND_DISPLAY: facts.waylandDisplay,
      ...session.driverEnvironment,
      ...extra,
    },
    compositing: async () => {
      asked++;
      return compositing;
    },
  });
  return { windowCapture, asked: () => asked };
}

describe("window capture on Linux (#1328)", () => {
  it("X11 captures a window's own pixels only while a compositing manager redirects windows", async () => {
    const x11 = { ...WAYLAND, display: ":0", waylandDisplay: undefined, currentDesktop: "i3" };
    expect(await check(x11, {}, true).windowCapture()).toBeUndefined();
    expect(await check(x11, {}, false).windowCapture()).toBe(UNREDIRECTED_CAPTURE);
  });

  it("XWayland is the window's own, since Xwayland redirects every window itself", async () => {
    const xwayland = check({ ...WAYLAND, display: ":0" }, {}, false);
    expect(await xwayland.windowCapture()).toBeUndefined();
    expect(xwayland.asked()).toBe(0);
  });

  it("pure Wayland is the window's own only where the driver itself sees Hyprland", async () => {
    expect(
      await check(WAYLAND, { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" }).windowCapture(),
    ).toBeUndefined();
    // The signature in the helper's own environment counts for nothing if the driver lacks it.
    expect(await check(WAYLAND).windowCapture()).toBe(CROPPED_CAPTURE);
    // Inject mode routes the driver elsewhere.
    expect(
      await check(WAYLAND, {
        HYPRLAND_INSTANCE_SIGNATURE: "abc_123",
        CUA_INJECT_SOCKET: "/run/cua.sock",
      }).windowCapture(),
    ).toBe(CROPPED_CAPTURE);
  });

  it("GNOME and every other Wayland compositor would crop, whatever helper is installed", async () => {
    const gnome = { ...WAYLAND, currentDesktop: "GNOME", gnomeShellMajor: 46 };
    expect(await check(gnome).windowCapture()).toBe(CROPPED_CAPTURE);
    expect(await check({ ...WAYLAND, currentDesktop: "sway" }).windowCapture()).toBe(
      CROPPED_CAPTURE,
    );
  });
});

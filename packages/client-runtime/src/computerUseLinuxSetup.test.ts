import type { ComputerUseReadiness } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linuxComputerUseSetup } from "./computerUseLinuxSetup.ts";

const READY: ComputerUseReadiness = {
  grants: { accessibility: "granted", screenCapture: "granted" },
  helper: "authenticated",
  capture: "ready",
  tree: "ready",
  input: "background",
  blockers: [],
  reasons: [],
  platform: { linux: { displayServer: "x11" } },
};

const status = (readiness: ComputerUseReadiness) =>
  Object.fromEntries(
    linuxComputerUseSetup(readiness, "lidge-ai").steps.map((step) => [step.id, step.status]),
  );

describe("linuxComputerUseSetup", () => {
  it("a proven X11 machine is ready with every step done", () => {
    const setup = linuxComputerUseSetup(READY, "lidge-ai");
    expect(setup.ready).toBe(true);
    expect(status(READY)).toEqual({
      session: "done",
      accessibility: "done",
      capture: "done",
      input: "done",
    });
  });

  it("without a desktop session it asks for one and shows no step as done", () => {
    const { platform: _platform, ...rest } = READY;
    const headless: ComputerUseReadiness = {
      ...rest,
      grants: { accessibility: "unknown", screenCapture: "unknown" },
      capture: "unavailable",
      tree: "unavailable",
      input: "unavailable",
      reasons: [
        "No D-Bus session bus is set (DBUS_SESSION_BUS_ADDRESS), and AT-SPI needs one to read app controls.",
      ],
    };
    const setup = linuxComputerUseSetup(headless, "lidge-ai");
    expect(setup.ready).toBe(false);
    expect(setup.steps).toEqual([
      expect.objectContaining({ id: "session", status: "action", detail: headless.reasons[0] }),
    ]);
  });

  it("AT-SPI off is an action with the GNOME setting to turn on, shown and never run", () => {
    const off = { ...READY, tree: "unavailable" } as const;
    const step = linuxComputerUseSetup(off, "lidge-ai").steps.find(
      (entry) => entry.id === "accessibility",
    );
    expect(step?.status).toBe("action");
    expect(step?.guidance).toContainEqual({
      kind: "command",
      text: "gsettings set org.gnome.desktop.interface toolkit-accessibility true",
    });
  });

  it("Wayland capture waits on the portal dialog, and a declined dialog becomes an action", () => {
    const wayland: ComputerUseReadiness = {
      ...READY,
      grants: { accessibility: "granted", screenCapture: "pending" },
      capture: "pending",
      input: "foregroundOnly",
      platform: { linux: { displayServer: "wayland" } },
    };
    expect(status(wayland)).toMatchObject({ capture: "waiting", input: "limited" });
    expect(linuxComputerUseSetup(wayland, "lidge-ai").ready).toBe(false);
    const declined = {
      ...wayland,
      grants: { accessibility: "granted", screenCapture: "denied" },
    } as const;
    expect(status(declined)).toMatchObject({ capture: "action" });
  });

  it("a proven machine that is blocked is not ready and says what blocks it", () => {
    const locked = { ...READY, blockers: ["screenLocked"] } as const;
    const setup = linuxComputerUseSetup(locked, "lidge-ai");
    expect(setup.ready).toBe(false);
    expect(setup.steps.at(-1)).toMatchObject({ id: "blocker", status: "action" });
  });

  it("a named display the helper cannot use keeps the helper's reason, and nothing reads done", () => {
    const blocked = (reason: string, displayServer: "x11" | "wayland"): ComputerUseReadiness => ({
      ...READY,
      grants: { accessibility: "unknown", screenCapture: "unknown" },
      capture: "unavailable",
      tree: "unavailable",
      input: "unavailable",
      reasons: [reason],
      platform: { linux: { displayServer } },
    });
    const noBus = blocked("No D-Bus session bus is set (DBUS_SESSION_BUS_ADDRESS).", "x11");
    expect(linuxComputerUseSetup(noBus, "lidge-ai").steps).toEqual([
      expect.objectContaining({ id: "session", status: "action", detail: noBus.reasons[0] }),
    ]);
    const gnome50 = blocked(
      "GNOME 50 on Wayland is not supported by Cua Driver 0.37.0.",
      "wayland",
    );
    const steps = linuxComputerUseSetup(gnome50, "lidge-ai").steps;
    expect(steps.some((step) => step.status === "done")).toBe(false);
    expect(JSON.stringify(steps)).not.toContain("can still read and use app controls");
  });
});

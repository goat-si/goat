import { describe, expect, it } from "vite-plus/test";

import {
  CUA_DESKTOP_UPDATE_NEEDED,
  computerUseStatusText,
  computerUseUnavailable,
  hostComputerUseText,
  readCuaGrants,
} from "./CuaSetupDialog.logic";

const mac = { platform: "darwin", running: true } as const;

describe("computerUseStatusText", () => {
  it("shows a grant revoked in System Settings even while the driver still runs", () => {
    expect(
      computerUseStatusText({
        enabled: true,
        status: mac,
        error: null,
        missingGrants: ["screen-recording"],
      }),
    ).toBe("Screen Recording is off. Choose Set up to allow it again.");
    expect(
      computerUseStatusText({
        enabled: true,
        status: mac,
        error: null,
        missingGrants: ["accessibility", "screen-recording"],
      }),
    ).toBe("Accessibility and Screen Recording are off. Choose Set up to allow it again.");
  });

  it("reports the host's last failure until a session starts the driver", () => {
    const failure =
      "Allow Accessibility and Screen Recording in System Settings, then restart computer use.";
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "darwin", running: false, failure },
        error: null,
        missingGrants: [],
      }),
    ).toBe(failure);
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "linux", running: false },
        error: null,
        missingGrants: [],
      }),
    ).toBe("Starts with the next agent turn");
    expect(
      computerUseStatusText({ enabled: false, status: mac, error: null, missingGrants: [] }),
    ).toBeNull();
  });

  it("says why a host's screen limits or blocks computer use before it is turned on", () => {
    const partial = {
      capability: "partial",
      reason:
        "Agents can take screenshots and use the mouse and keyboard on :1, but cannot read app controls.",
      display: ":1",
    } as const;
    const xvfb = { platform: "linux", running: false, display: partial } as const;
    expect(
      computerUseStatusText({ enabled: false, status: xvfb, error: null, missingGrants: [] }),
    ).toBe(partial.reason);
    expect(
      computerUseStatusText({
        enabled: true,
        status: { ...xvfb, running: true },
        error: null,
        missingGrants: [],
      }),
    ).toBe(`Running with limits. ${partial.reason}`);
    const blocked = {
      platform: "linux",
      running: false,
      display: { capability: "unavailable", reason: "No X display is reachable for root." },
    } as const;
    expect(computerUseUnavailable(blocked)).toBe(true);
    expect(computerUseUnavailable(xvfb)).toBe(false);
    // Hosts that predate the check keep the switch.
    expect(computerUseUnavailable({ platform: "linux", running: false })).toBe(false);
    expect(
      computerUseStatusText({ enabled: false, status: blocked, error: null, missingGrants: [] }),
    ).toBe("No X display is reachable for root.");
  });
});

describe("hostComputerUseText", () => {
  it("summarizes computer use for a host card", () => {
    expect(hostComputerUseText(undefined)).toBeNull();
    expect(
      hostComputerUseText({
        enabled: false,
        running: false,
        capability: "available",
        reason: "jun is signed in at this Mac.",
        display: "console",
      }),
    ).toBe("Off");
    expect(
      hostComputerUseText({
        enabled: true,
        running: true,
        capability: "available",
        reason: "Uses X display :0.",
        display: ":0",
      }),
    ).toBe("On, running (:0)");
    expect(
      hostComputerUseText({
        enabled: false,
        running: false,
        capability: "partial",
        reason: "No AT-SPI.",
        display: ":1",
      }),
    ).toBe("Off, limited. No AT-SPI.");
    expect(
      hostComputerUseText({
        enabled: false,
        running: false,
        capability: "unavailable",
        reason: "GOAT runs in Windows Session 0.",
      }),
    ).toBe("Unavailable. GOAT runs in Windows Session 0.");
  });
});

describe("readCuaGrants", () => {
  it("asks an older desktop to update instead of trusting GOAT's own grants", async () => {
    // Such a desktop may already run computer use through the helper.
    expect(await readCuaGrants({})).toEqual({
      principal: "unusable",
      message: CUA_DESKTOP_UPDATE_NEEDED,
    });
    expect(await readCuaGrants(undefined)).toEqual({
      principal: "unusable",
      message: CUA_DESKTOP_UPDATE_NEEDED,
    });
  });
});

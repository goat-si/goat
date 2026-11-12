import { describe, expect, it } from "vite-plus/test";
import { computerUseReady, type ComputerUseReadiness } from "@goat/contracts";

import {
  CUA_DESKTOP_UPDATE_NEEDED,
  CUA_GRANT_READS_INITIAL,
  CUA_READ_FAILED,
  computerUseStatusText,
  computerUseUnavailable,
  cuaGrantReadsAfter,
  cuaGrantTroubleshooting,
  hostComputerUseText,
  readCuaGrants,
  withLiveGrants,
} from "./CuaSetupDialog.logic";

const mac = { platform: "darwin", running: true } as const;

describe("computerUseStatusText", () => {
  it("reports the host's last failure until a session starts the driver", () => {
    const failure =
      "Allow Accessibility and Screen Recording in System Settings, then restart computer use.";
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "darwin", running: false, failure },
        error: null,
      }),
    ).toBe(failure);
    expect(
      computerUseStatusText({
        enabled: true,
        status: { platform: "linux", running: false },
        error: null,
      }),
    ).toBe("Starts with the next agent turn");
    expect(computerUseStatusText({ enabled: false, status: mac, error: null })).toBeNull();
  });

  it("says why a host's screen limits or blocks computer use before it is turned on", () => {
    const partial = {
      capability: "partial",
      reason:
        "Agents can take screenshots and use the mouse and keyboard on :1, but cannot read app controls.",
      display: ":1",
    } as const;
    const xvfb = { platform: "linux", running: false, display: partial } as const;
    expect(computerUseStatusText({ enabled: false, status: xvfb, error: null })).toBe(
      partial.reason,
    );
    expect(
      computerUseStatusText({
        enabled: true,
        status: { ...xvfb, running: true },
        error: null,
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
    expect(computerUseStatusText({ enabled: false, status: blocked, error: null })).toBe(
      "No X display is reachable for root.",
    );
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

describe("cuaGrantReadsAfter", () => {
  const waiting = {
    principal: "helper",
    name: "GOAT Computer Use",
    bundleId: "si.goat.desktop.computer-use",
    accessibility: false,
    screenRecording: false,
  } as const;
  const slow = {
    principal: "unusable",
    message: "GOAT Computer Use did not answer: it took too long.",
    unanswered: "tookTooLong",
  } as const;
  const answeredOnce = () => cuaGrantReadsAfter(CUA_GRANT_READS_INITIAL, waiting, false);

  it("keeps the last answer through one failed read and says the app did not answer after two in a row", () => {
    const once = cuaGrantReadsAfter(answeredOnce(), slow, false);
    expect(once).toMatchObject({
      grants: waiting,
      unanswered: null,
      error: "Could not check permissions. We'll try again automatically.",
    });
    const twice = cuaGrantReadsAfter(once, slow, false);
    expect(twice.unanswered).toEqual({ reason: "tookTooLong", message: slow.message });
    expect(twice.error).toBeNull();
    // A read that answers in between starts the count again; one that answers after ends it.
    const again = cuaGrantReadsAfter(cuaGrantReadsAfter(once, waiting, false), slow, false);
    expect(again.unanswered).toBeNull();
    expect(cuaGrantReadsAfter(twice, waiting, false)).toMatchObject({
      grants: waiting,
      unanswered: null,
      error: null,
    });
  });

  it("says so at once when the app refused GOAT or when a person asked for the read", () => {
    const refused = {
      principal: "unusable",
      message: "GOAT Computer Use did not answer: it refused GOAT.",
      unanswered: "refused",
    } as const;
    expect(cuaGrantReadsAfter(answeredOnce(), refused, false).unanswered).toEqual({
      reason: "refused",
      message: refused.message,
    });
    expect(cuaGrantReadsAfter(answeredOnce(), slow, true).unanswered?.reason).toBe("tookTooLong");
  });

  it("counts a read the desktop could not make at all the same way, with no reason to give", () => {
    const once = cuaGrantReadsAfter(answeredOnce(), null, false);
    expect(once.unanswered).toBeNull();
    expect(cuaGrantReadsAfter(once, null, false).unanswered).toEqual({
      reason: null,
      message: CUA_READ_FAILED,
    });
  });

  it("takes a helper that can never be used as an answer, not as a read that failed", () => {
    const broken = { principal: "unusable", message: "It cannot be used (EACCES)." } as const;
    expect(cuaGrantReadsAfter(answeredOnce(), broken, false)).toMatchObject({
      grants: broken,
      unanswered: null,
      error: null,
    });
  });
});

describe("cuaGrantTroubleshooting", () => {
  const helper = {
    principal: "helper",
    name: "GOAT Computer Use",
    bundleId: "si.goat.desktop.nightly.computer-use",
    accessibility: false,
    screenRecording: false,
  } as const;
  const tips = () => cuaGrantTroubleshooting(helper);

  it("does not claim a row that is on belongs to an older copy, and says each GOAT app lists its own helper", () => {
    const text = tips().join(" ");
    expect(text).not.toContain("belongs to an older copy");
    expect(text).toContain("the row that is on may be for another copy");
    expect(text).toContain(
      "GOAT and GOAT Nightly each list their own GOAT Computer Use, and only the one for the app you are using counts.",
    );
  });

  it("never suggests removing a row without saying the other GOAT app loses its permission", () => {
    const removal = tips().filter((tip) => /remov/iu.test(tip));
    expect(removal).not.toHaveLength(0);
    for (const tip of removal) expect(tip).toContain("the other GOAT app");
    expect(tips().join(" ")).not.toMatch(/every GOAT Computer Use row/u);
  });

  it("keeps the reset commands, for the copy GOAT is checking only", () => {
    expect(tips().at(-1)).toContain(
      "tccutil reset Accessibility si.goat.desktop.nightly.computer-use and tccutil reset ScreenCapture si.goat.desktop.nightly.computer-use",
    );
  });
});

describe("withLiveGrants", () => {
  const reported: ComputerUseReadiness = {
    grants: { accessibility: "granted", screenCapture: "granted" },
    helper: "authenticated",
    capture: "ready",
    tree: "ready",
    input: "background",
    blockers: [],
    reasons: [],
  };
  const live = (accessibility: boolean, screenRecording: boolean) =>
    ({
      principal: "helper",
      name: "GOAT Computer Use",
      bundleId: "si.goat.desktop.computer-use",
      accessibility,
      screenRecording,
    }) as const;

  it("shows a grant revoked since the helper's last report as denied, so the host is not ready", () => {
    const merged = withLiveGrants(reported, live(false, true));
    expect(merged?.grants).toEqual({ accessibility: "denied", screenCapture: "granted" });
    expect(computerUseReady(merged!)).toBe(false);
    expect(computerUseReady(reported)).toBe(true);
  });

  it("never marks a grant granted that the report has not proven", () => {
    const pending = {
      ...reported,
      grants: { accessibility: "pending", screenCapture: "unknown" },
    } as const;
    expect(withLiveGrants(pending, live(true, true))?.grants).toEqual(pending.grants);
  });
});

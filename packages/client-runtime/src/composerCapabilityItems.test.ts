import { describe, expect, it } from "vite-plus/test";

import {
  composerCapabilityDetail,
  matchComposerCapabilityItems,
  turnCapabilityAvailability,
  type ComposerCapabilityContext,
} from "./composerCapabilityItems.ts";

const ready: ComposerCapabilityContext = {
  interactionMode: "default",
  providerDriver: "codex",
  computerUse: {
    enabled: true,
    status: {
      platform: "darwin",
      running: false,
      display: { capability: "available", reason: "", display: "console" },
    },
  },
};
const status = (overrides: object) => ({
  ...ready,
  computerUse: {
    enabled: true,
    status: { platform: "linux" as const, running: false, ...overrides },
  },
});

describe("composer capability entries", () => {
  it("offers Computer and Browser on a bare @ and filters by what was typed", () => {
    expect(matchComposerCapabilityItems("", ready).map((item) => item.label)).toEqual([
      "Computer",
      "Browser",
    ]);
    expect(matchComposerCapabilityItems("bro", ready).map((item) => item.capability)).toEqual([
      "browser",
    ]);
    expect(matchComposerCapabilityItems("desk", ready).map((item) => item.capability)).toEqual([
      "computer-use",
    ]);
    expect(matchComposerCapabilityItems("src/", ready)).toEqual([]);
  });

  it.each([
    ["plan mode", { ...ready, interactionMode: "plan" as const }, false],
    ["a provider that runs elsewhere", { ...ready, providerDriver: "cursorCloud" }, false],
    ["an unsupported platform", status({ platform: "other" }), false],
    [
      "no usable screen",
      status({ display: { capability: "unavailable", reason: "No graphical session." } }),
      true,
    ],
    [
      "computer use turned off",
      { ...ready, computerUse: { ...ready.computerUse!, enabled: false } },
      true,
    ],
    ["a failed host check", { ...ready, computerUse: { error: "connection lost" } }, true],
  ])(
    "is unavailable with %s, and offers setup only where Settings can fix it",
    (_, context, setup) => {
      const availability = turnCapabilityAvailability("computer-use", context);
      expect(availability.state).toBe("unavailable");
      expect(availability.state === "unavailable" && availability.setup).toBe(setup);
      expect(turnCapabilityAvailability("browser", context).state).toBe("available");
    },
  );

  it("is checking, not unavailable or ready, until the first host check answers", () => {
    const [computer] = matchComposerCapabilityItems("", { ...ready, computerUse: null });
    expect(computer?.availability).toEqual({ state: "checking" });
    expect(composerCapabilityDetail(computer!)).toBe("Checking this host…");
  });

  it("runs with limited support and says what is limited", () => {
    const limited = status({
      display: { capability: "partial", reason: "Wayland limits which apps it can use." },
    });
    expect(turnCapabilityAvailability("computer-use", limited)).toEqual({
      state: "available",
      note: "Wayland limits which apps it can use.",
    });
    expect(turnCapabilityAvailability("computer-use", ready)).toEqual({
      state: "available",
      note: null,
    });
  });
});

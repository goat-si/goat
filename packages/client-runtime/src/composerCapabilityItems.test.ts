import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerCapabilityItems,
  turnCapabilityUnavailableReason,
  type ComposerCapabilityContext,
} from "./composerCapabilityItems.ts";

const ready: ComposerCapabilityContext = {
  interactionMode: "default",
  computerUse: {
    enabled: true,
    status: {
      platform: "darwin",
      running: true,
      display: { capability: "available", reason: "", display: "console" },
    },
  },
};

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
    [{ ...ready, interactionMode: "plan" as const }, "Computer use is off in plan mode."],
    [
      { ...ready, computerUse: { ...ready.computerUse!, enabled: false } },
      "Computer use is off for this host. Set it up to use it.",
    ],
    [
      {
        ...ready,
        computerUse: { enabled: true, status: { platform: "other" as const, running: false } },
      },
      "Computer use isn't available on this host.",
    ],
    [
      {
        ...ready,
        computerUse: {
          enabled: true,
          status: {
            platform: "linux" as const,
            running: false,
            display: { capability: "unavailable" as const, reason: "No graphical session." },
          },
        },
      },
      "No graphical session.",
    ],
    [{ ...ready, computerUse: null }, "Checking computer use on this host…"],
  ])("says why computer use cannot run (%#)", (context, reason) => {
    expect(turnCapabilityUnavailableReason("computer-use", context)).toBe(reason);
    expect(turnCapabilityUnavailableReason("browser", context)).toBeNull();
  });

  it("is available when the host is ready", () => {
    expect(turnCapabilityUnavailableReason("computer-use", ready)).toBeNull();
  });
});

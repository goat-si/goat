import { describe, expect, it } from "vite-plus/test";

import { GOAT_IOS_TESTFLIGHT_URL, shouldShowNightlyMobileBeta } from "./NightlyMobileBeta";

describe("shouldShowNightlyMobileBeta", () => {
  it("never points at the upstream T3 Code TestFlight", () => {
    expect(GOAT_IOS_TESTFLIGHT_URL ?? "").not.toContain("XgaxaRtd");
  });

  it("hides the beta on Nightly while GOAT has no TestFlight link", () => {
    expect(shouldShowNightlyMobileBeta({ isNightly: true, testflightUrl: null })).toBe(false);
    expect(shouldShowNightlyMobileBeta({ isNightly: true, testflightUrl: undefined })).toBe(false);
    expect(shouldShowNightlyMobileBeta({ isNightly: true, testflightUrl: "" })).toBe(false);
  });

  it("shows the beta on Nightly once a TestFlight link is set", () => {
    expect(
      shouldShowNightlyMobileBeta({
        isNightly: true,
        testflightUrl: "https://testflight.apple.com/join/goat",
      }),
    ).toBe(true);
  });

  it("hides the beta outside Nightly even with a link", () => {
    expect(
      shouldShowNightlyMobileBeta({
        isNightly: false,
        testflightUrl: "https://testflight.apple.com/join/goat",
      }),
    ).toBe(false);
  });
});

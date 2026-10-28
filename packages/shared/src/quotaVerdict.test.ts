import { describe, expect, it } from "vite-plus/test";

import { appliesToModel, freshWindows, isWindowExhausted, verdictWindows } from "./quotaVerdict.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const LATER = "2026-10-20T05:00:00.000Z";
const EARLIER = "2026-10-19T20:00:00.000Z";

describe("quota verdict", () => {
  it("judges a reset first, then the producer's verdict, then the percentage", () => {
    expect(
      isWindowExhausted({ label: "W", usedPercent: 100, exhausted: true, resetsAt: EARLIER }, NOW),
    ).toBe(false);
    expect(
      isWindowExhausted({ label: "W", usedPercent: 100, exhausted: false, resetsAt: LATER }, NOW),
    ).toBe(false);
    expect(isWindowExhausted({ label: "Availability", exhausted: true }, NOW)).toBe(true);
    expect(isWindowExhausted({ label: "W", usedPercent: 100 }, NOW)).toBe(true);
    expect(isWindowExhausted({ label: "W", usedPercent: 99 }, NOW)).toBe(false);
    expect(isWindowExhausted({ label: "Unknown" }, NOW)).toBe(false);
  });

  it("keeps stale readings only as proof of exhaustion, by each window's own observation", () => {
    const windows = [
      { label: "fresh", usedPercent: 10, observedAt: "2026-10-19T23:58:00.000Z" },
      { label: "stale", usedPercent: 96, observedAt: EARLIER },
      { label: "stale full", usedPercent: 100, observedAt: EARLIER, resetsAt: LATER },
      { label: "reset", usedPercent: 100, resetsAt: EARLIER },
      { label: "report time", usedPercent: 50 },
    ];
    expect(
      freshWindows(windows, "2026-10-19T23:59:00.000Z", NOW).map((window) => window.label),
    ).toEqual(["fresh", "stale full", "report time"]);
    expect(freshWindows(windows, EARLIER, NOW).map((window) => window.label)).toEqual([
      "fresh",
      "stale full",
    ]);
  });

  it("gates scoped readings only for their model family, and adds availability without a percentage", () => {
    expect(appliesToModel("family:opus", "anthropic/claude-opus-4-6")).toBe(true);
    expect(appliesToModel("family:opus", "claude-sonnet-4-6")).toBe(false);
    expect(appliesToModel("family:opus", undefined)).toBe(false);
    expect(appliesToModel(undefined, undefined)).toBe(true);
    expect(
      verdictWindows({
        windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 40 }],
        availability: [{ id: "availability", label: "Availability", exhausted: true }],
      }).map((window) => [window.label, window.usedPercent]),
    ).toEqual([
      ["Weekly", 40],
      ["Availability", undefined],
    ]);
  });
});

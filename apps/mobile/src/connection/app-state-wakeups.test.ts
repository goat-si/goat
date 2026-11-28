import { describe, expect, it } from "@effect/vitest";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it.each([
    ["inactive without background", null, 5_000, null],
    ["background just under 10 s", 0, 9_999, "application-active-probe"],
    ["background of 10 s or more", 0, 10_000, "application-active-long"],
  ] as const)("%s", (_case, backgroundedAtMs, activeAtMs, expected) => {
    expect(mobileApplicationActiveWakeup(backgroundedAtMs, activeAtMs)).toBe(expected);
  });
});

describe("foreground handoff wakeups", () => {
  it("probes a live OS handoff even after a long interruption", () => {
    expect(mobileApplicationActiveWakeup(20_000, 120_000, true)).toBe("application-active-probe");
  });
  it("uses the long resume probe after an ordinary background suspension", () => {
    expect(mobileApplicationActiveWakeup(20_000, 120_000, false)).toBe("application-active-long");
  });
});

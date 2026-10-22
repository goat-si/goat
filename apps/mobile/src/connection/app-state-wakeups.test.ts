import { describe, expect, it } from "@effect/vitest";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

describe("foreground handoff wakeups", () => {
  it("probes a live OS handoff even after a long interruption", () => {
    expect(mobileApplicationActiveWakeup(20_000, 120_000, true)).toBe("application-active-probe");
  });
  it("still reconnects after an ordinary background suspension", () => {
    expect(mobileApplicationActiveWakeup(20_000, 120_000, false)).toBe(
      "application-active-reconnect",
    );
  });
});

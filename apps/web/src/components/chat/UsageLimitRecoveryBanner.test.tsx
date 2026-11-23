import { RunId } from "@goat/contracts";
import type { TimestampFormat } from "@goat/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});

it("uses past tense after the reset time", () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 20, 15, 14).getTime());
  expect(bannerDescription(new Date(2026, 9, 20, 15, 0), "24-hour")).toBe("Reset 15:00");
});

it("uses the snooze wake time until it passes", () => {
  const runId = RunId.make("run-snooze");
  const reset = new Date(2026, 9, 20, 15, 0).toISOString();
  const props = {
    runId,
    errorCode: null,
    resetAt: reset,
    stoppedAt: stoppedAt.toISOString(),
    settled: false,
    requestPending: false,
    snoozedUntil: new Date(2026, 9, 20, 16, 0).toISOString(),
    recovery: { runId, resetAt: reset, autoResume: true },
    timestampFormat: "24-hour" as const,
    onChange: async () => {},
  };
  {
    using _now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 20, 15, 14).getTime());
    expect(usageLimitRecoveryBannerItem(props).description).toBe("Resumes 16:00");
  }
  {
    using _now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 9, 20, 16, 5).getTime());
    expect(usageLimitRecoveryBannerItem(props).description).toBe("Reset 15:00");
  }
});

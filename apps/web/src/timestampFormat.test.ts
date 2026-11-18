import { describe, expect, it } from "vite-plus/test";
import { goatBotRowTime } from "@goat/client-runtime/goatBot";

import {
  formatDayAwareTimestamp,
  formatRelativeElapsed,
  formatUpcomingTimestamp,
} from "./timestampFormat";

describe("GOAT Bot work rows", () => {
  // Home's rows use client-runtime's scale; the sidebar uses this one. They must say the same.
  it("keep the compact scale of web's relative time", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z");
    for (const elapsed of [
      0,
      59_999,
      60_000,
      3_599_999,
      3_600_000,
      86_399_999,
      86_400_000,
      9 * 86_400_000,
      30 * 86_400_000,
      400 * 86_400_000,
    ]) {
      const web = formatRelativeElapsed(elapsed).value;
      expect(goatBotRowTime(new Date(now - elapsed).toISOString(), now)?.text).toBe(
        web === "just now" ? "now" : web,
      );
    }
  });
});

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

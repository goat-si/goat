import { expect, it, vi } from "vite-plus/test";
import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatShortTimestamp,
  formatTimestamp,
} from "./timestampFormat";

it("updates local timestamp formats after the system time zone changes", () => {
  using _zone = { [Symbol.dispose]: () => vi.unstubAllEnvs() };
  const instant = "2026-10-31T20:00:00.000Z";
  const format = (timeZone: string, seconds = false) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {}),
      hour12: true,
      timeZone,
    }).format(new Date(instant));
  vi.stubEnv("TZ", "America/New_York");
  expect(formatShortTimestamp(instant, "12-hour")).toBe(format("America/New_York"));
  expect(formatTimestamp(instant, "12-hour")).toBe(format("America/New_York", true));
  vi.stubEnv("TZ", "Asia/Bangkok");
  expect(formatShortTimestamp(instant, "12-hour")).toBe(format("Asia/Bangkok"));
  expect(formatTimestamp(instant, "12-hour")).toBe(format("Asia/Bangkok", true));
  expect(formatChatTimestampTooltip(instant, "12-hour")).toContain("1st November 2026");
  expect(formatDayAwareTimestamp(instant, "12-hour", Date.parse(instant), "America/New_York")).toBe(
    format("America/New_York"),
  );
});

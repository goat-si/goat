import { expect, it, vi } from "vite-plus/test";
import { createMessageTimeFormatter, formatMessageTimestamp } from "./messageTimestamp";

it("uses the system-selected 24-hour clock instead of the locale default", () => {
  const time = new Date(2026, 1, 3, 18, 5, 0);
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  });
  expect(formatMessageTimestamp(time.toISOString(), time.getTime(), clock)).toBe("18:05");
});

it("updates a cached formatter when the system time zone changes", () => {
  const previous = process.env.TZ;
  vi.useFakeTimers({ now: 0 });
  const instant = "2026-11-07T04:45:43.877Z";
  try {
    process.env.TZ = "America/New_York";
    const clock = createMessageTimeFormatter(true, "en-US");
    expect(clock(instant, Date.parse(instant))).toBe("23:45");
    process.env.TZ = "Asia/Bangkok";
    vi.advanceTimersByTime(1000);
    expect(clock(instant, Date.parse(instant))).toBe("11:45");
  } finally {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

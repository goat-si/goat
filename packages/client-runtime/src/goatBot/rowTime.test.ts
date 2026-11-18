import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { goatBotRowTime } from "./rowTime.ts";

describe("goatBotRowTime", () => {
  it("says a row's last activity compactly for sight and in words for a screen reader", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z");
    const ago = (ms: number) =>
      goatBotRowTime(DateTime.formatIso(DateTime.makeUnsafe(now - ms)), now);
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    expect(
      [
        0,
        MINUTE - 1,
        MINUTE,
        2 * MINUTE - 1,
        2 * MINUTE,
        HOUR - 1,
        HOUR,
        2 * HOUR,
        DAY - 1,
        DAY,
        3 * DAY,
      ].map(ago),
    ).toEqual([
      { text: "now", spoken: "just now" },
      { text: "now", spoken: "just now" },
      { text: "1m", spoken: "1 minute ago" },
      { text: "1m", spoken: "1 minute ago" },
      { text: "2m", spoken: "2 minutes ago" },
      { text: "59m", spoken: "59 minutes ago" },
      { text: "1h", spoken: "1 hour ago" },
      { text: "2h", spoken: "2 hours ago" },
      { text: "23h", spoken: "23 hours ago" },
      { text: "1d", spoken: "1 day ago" },
      { text: "3d", spoken: "3 days ago" },
    ]);
    // A clock behind the server's says "now" rather than a time to come.
    expect(ago(-5_000)).toEqual({ text: "now", spoken: "just now" });
    expect(goatBotRowTime("not a time", now)).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { diskPressureNotice, parseAnnouncedLevel } from "./diskPressureNotifications.logic";

describe("disk pressure notifications", () => {
  it("notify once per rise, never for the same level again, and again after easing", () => {
    let announced: "ok" | "elevated" | "critical" | null = null;
    const notified: Array<string> = [];
    for (const level of [
      "ok",
      "elevated",
      "elevated",
      "critical",
      "critical",
      "elevated",
      "critical",
      "ok",
      "elevated",
    ] as const) {
      const notice = diskPressureNotice(announced, level);
      if (notice.notify) notified.push(level);
      announced = notice.announce;
    }
    expect(notified).toEqual(["elevated", "critical", "critical", "elevated"]);
  });

  it("does not repeat a stored level after a reload", () => {
    expect(diskPressureNotice(parseAnnouncedLevel("critical"), "critical").notify).toBe(false);
    expect(diskPressureNotice(parseAnnouncedLevel("garbage"), "elevated").notify).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  announcedAfter,
  diskPressureNotice,
  parseAnnouncedLevel,
} from "./diskPressureNotifications.logic";

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

  it("keeps a warning nobody was shown pending until it is shown", () => {
    const unseen = diskPressureNotice("ok", "critical");
    expect(announcedAfter(unseen, false)).toBeNull();
    // The stored level stays "ok", so the next reading (on focus) notifies again.
    const retry = diskPressureNotice("ok", "critical");
    expect(retry.notify).toBe(true);
    expect(announcedAfter(retry, true)).toBe("critical");
    // Easing is recorded without being shown, so a later rise is news again.
    expect(announcedAfter(diskPressureNotice("critical", "ok"), false)).toBe("ok");
  });
});

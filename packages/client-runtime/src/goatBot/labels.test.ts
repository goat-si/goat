import { describe, expect, it } from "vite-plus/test";
import { formatGoatBotStamp, goatBotReceiptLabel, goatBotStampParts } from "./labels.ts";

const time = (iso: string) => iso.slice(11, 16);

describe("goatBotReceiptLabel", () => {
  it("distinguishes every delivery stage and uses readAt for the read time", () => {
    expect(goatBotReceiptLabel({ state: "queued" }, time)).toEqual({
      text: "Waiting to send",
      accessibleText: "Waiting to send",
    });
    expect(goatBotReceiptLabel({ state: "sending" }, time)?.text).toBe("Sending…");
    expect(goatBotReceiptLabel({ state: "sent" }, time)?.text).toBe("Sent");
    expect(goatBotReceiptLabel({ state: "delivered" }, time)).toEqual({
      text: "Delivered",
      accessibleText: "Delivered to GOAT Bot",
    });
    expect(goatBotReceiptLabel({ state: "read", readAt: "2026-10-12T09:41:00Z" }, time)).toEqual({
      text: "Read 09:41",
      accessibleText: "Read by GOAT Bot at 09:41",
    });
    expect(goatBotReceiptLabel({ state: "failed", clientKey: "x" }, time)).toBeNull();
  });
});

describe("formatGoatBotStamp", () => {
  it("uses local calendar days across midnight and names older dates", () => {
    const local = (year: number, month: number, day: number, hour: number, minute: number) => {
      // @effect-diagnostics-next-line globalDate:off - exercise the device's local midnight boundary.
      return new Date(year, month, day, hour, minute).toISOString();
    };
    // @effect-diagnostics-next-line globalDate:off - exercise the device's local midnight boundary.
    const now = new Date(2026, 9, 19, 0, 1).getTime();
    const displayTime = (iso: string) => {
      // @effect-diagnostics-next-line globalDate:off - Intl formats a local display time.
      const date = new Date(iso);
      return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
    };
    expect(formatGoatBotStamp(local(2026, 9, 19, 0, 0), now, displayTime)).toContain(
      "Today 12:00 AM",
    );
    expect(formatGoatBotStamp(local(2026, 9, 18, 23, 59), now, displayTime)).toContain(
      "Yesterday 11:59 PM",
    );
    // Weekday and date names follow the device locale; compare with the same formatting.
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
      // @effect-diagnostics-next-line globalDate:off - compare against the same local date.
      new Date(local(2026, 9, 16, 9, 41)),
    );
    const older = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      // @effect-diagnostics-next-line globalDate:off - compare against the same local date.
    }).format(new Date(local(2026, 9, 12, 9, 41)));
    expect(formatGoatBotStamp(local(2026, 9, 16, 9, 41), now, displayTime)).toBe(
      `${weekday} 9:41 AM`,
    );
    expect(formatGoatBotStamp(local(2026, 9, 12, 9, 41), now, displayTime)).toBe(
      `${older} at 9:41 AM`,
    );
  });

  it.each(["8:13 PM", "20:13", "오후 8:13"])(
    "keeps all four stamp leads separate from %s time",
    (displayTime) => {
      const local = (day: number) => {
        // @effect-diagnostics-next-line globalDate:off - stamps use the device's local calendar.
        return new Date(2026, 9, day, 20, 13).toISOString();
      };
      // @effect-diagnostics-next-line globalDate:off - stamps use the device's local calendar.
      const now = new Date(2026, 9, 19, 20, 14).getTime();
      const formatTime = () => displayTime;
      const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(
        // @effect-diagnostics-next-line globalDate:off - compare against the same local date.
        new Date(local(16)),
      );
      const older = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(
        // @effect-diagnostics-next-line globalDate:off - compare against the same local date.
        new Date(local(12)),
      );

      for (const [day, lead] of [
        [19, "Today"],
        [18, "Yesterday"],
        [16, weekday],
        [12, `${older} at`],
      ] as const) {
        const iso = local(day);
        expect(goatBotStampParts(iso, now, formatTime)).toEqual({ lead, time: displayTime });
        expect(formatGoatBotStamp(iso, now, formatTime)).toBe(`${lead} ${displayTime}`);
      }
    },
  );

  it("keeps invalid dates empty without formatting their time", () => {
    const formatTime = () => {
      throw new Error("invalid date must not reach time formatter");
    };
    expect(goatBotStampParts("invalid", 0, formatTime)).toEqual({ lead: "", time: "" });
    expect(formatGoatBotStamp("invalid", 0, formatTime)).toBe("");
  });
});

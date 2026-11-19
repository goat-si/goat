import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { codexMessageResetAt, codexTimeZone } from "./codexUsageLimits.ts";
import { failureResetAt } from "./CodexManagedFailure.ts";

describe("Codex text reset times", () => {
  const dhaka = DateTime.zoneMakeNamedUnsafe("Asia/Dhaka");
  const failed = DateTime.makeUnsafe("2026-11-07T03:00:00Z");
  it("reads local same-day and dated reset times", () => {
    expect(codexMessageResetAt("Try again at 3:37 PM.", failed, dhaka)).toBe(
      "2026-11-07T09:38:00.000Z",
    );
    expect(codexMessageResetAt("try again at Dec 1st, 2026 12:05 AM.", failed, dhaka)).toBe(
      "2026-11-30T18:06:00.000Z",
    );
  });
  it("rejects invalid or past reset times", () => {
    for (const text of [
      "Try again at 13:99 PM.",
      "Try again at Feb 31st, 2027 2:00 PM.",
      "Try again at 8:15 AM.",
      "try later",
    ])
      expect(codexMessageResetAt(text, failed, dhaka)).toBeNull();
  });
  it("uses the later instant for a repeated DST hour", () => {
    expect(
      codexMessageResetAt(
        "Try again at 1:30 AM.",
        DateTime.makeUnsafe("2026-11-01T05:15:00Z"),
        DateTime.zoneMakeNamedUnsafe("America/New_York"),
      ),
    ).toBe("2026-11-01T06:31:00.000Z");
  });
  it("rejects a nonexistent local time during a DST spring transition", () => {
    expect(
      codexMessageResetAt(
        "Try again at Mar 8th, 2026 2:30 AM.",
        DateTime.makeUnsafe("2026-03-08T05:00:00Z"),
        DateTime.zoneMakeNamedUnsafe("America/New_York"),
      ),
    ).toBeNull();
  });
  it("uses the Codex process time zone", () => {
    expect(DateTime.zoneToString(codexTimeZone({ TZ: ":Asia/Dhaka" }))).toBe("Asia/Dhaka");
  });
  it("uses text only when the snapshot and managed caps do not supply a reset", () => {
    const failure = {
      class: "usage_limit",
      message: "Try again at 3:37 PM.",
      code: null,
      retryable: null,
    } as const;
    const text = { failedAt: failed, zone: dhaka };
    expect(failureResetAt(failure, undefined, text)).toBe("2026-11-07T09:38:00.000Z");
    expect(
      failureResetAt(failure, { primary: { usedPercent: 100, resetsAt: 2000000000 } }, text),
    ).toBe("2033-05-18T03:33:20.000Z");
    expect(
      failureResetAt(
        { ...failure, code: "subscription_sharing_usage_limit_exceeded" },
        undefined,
        text,
      ),
    ).toBeNull();
  });
});

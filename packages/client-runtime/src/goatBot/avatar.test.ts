import { describe, expect, it } from "vite-plus/test";

import { goatBotAvatarEmoji, goatBotAvatarSignal } from "./avatar.ts";
import type { GoatBotFaceState } from "./face.ts";

const STATES: ReadonlyArray<GoatBotFaceState> = [
  "idle",
  "reading",
  "working",
  "waiting",
  "failed",
  "finished",
  "sleeping",
];

describe("goatBotAvatarEmoji", () => {
  it("draws a chosen emoji and falls back to the face when none is set", () => {
    expect(goatBotAvatarEmoji(" 🐙 ")).toBe("🐙");
    expect(goatBotAvatarEmoji("   ")).toBeNull();
    expect(goatBotAvatarEmoji(null)).toBeNull();
    expect(goatBotAvatarEmoji(undefined)).toBeNull();
  });
});

describe("goatBotAvatarSignal", () => {
  it("keeps every state but idle visible on an emoji, which has no eyes", () => {
    const signals = Object.fromEntries(
      STATES.map((state) => [state, goatBotAvatarSignal(state, true)]),
    );
    expect(signals).toEqual({
      idle: { ring: null, waitingDot: false, dimmed: false },
      reading: { ring: "active", waitingDot: false, dimmed: false },
      working: { ring: "active", waitingDot: false, dimmed: false },
      waiting: { ring: null, waitingDot: true, dimmed: false },
      failed: { ring: "failed", waitingDot: false, dimmed: false },
      finished: { ring: "finished", waitingDot: false, dimmed: false },
      sleeping: { ring: null, waitingDot: false, dimmed: true },
    });
  });

  it("leaves the face's own signals as they are, since its eyes show the rest", () => {
    const rings = STATES.map((state) => goatBotAvatarSignal(state, false));
    expect(
      rings.filter((signal) => signal.ring !== null || signal.waitingDot || signal.dimmed),
    ).toEqual([
      { ring: "active", waitingDot: false, dimmed: false },
      { ring: null, waitingDot: true, dimmed: false },
      { ring: "failed", waitingDot: false, dimmed: false },
    ]);
  });
});

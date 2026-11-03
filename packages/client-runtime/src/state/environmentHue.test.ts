import { describe, expect, it } from "vite-plus/test";
import { assignEnvironmentHueSlots, ENVIRONMENT_HUE_SLOT_COUNT } from "./environmentHue.ts";

const ids = [
  "juns-macbook-pro",
  "juns-mac-studio",
  "lidge-ai",
  "epyc-01",
  "headless-1",
  "headless-2",
  "cloud-sandbox",
  "raspberry-pi",
];

describe("environment hue assignment", () => {
  it("is stable across input order, deduplicates ids, and reuses slots after eight", () => {
    const slots = assignEnvironmentHueSlots(ids);
    expect(assignEnvironmentHueSlots([...ids.toReversed(), ids[0]!])).toEqual(slots);
    expect(new Set(slots.values()).size).toBe(ENVIRONMENT_HUE_SLOT_COUNT);
    expect(assignEnvironmentHueSlots([...ids, "z-extra"]).size).toBe(9);
  });
  it("assigns remote devices without reserving a slot for the hub", () => {
    const hub = ids[0]!;
    const remote = ids.filter((id) => id !== hub);
    const slots = assignEnvironmentHueSlots(remote);
    expect(slots.has(hub)).toBe(false);
    expect(new Set(slots.values()).size).toBe(remote.length);
  });
});

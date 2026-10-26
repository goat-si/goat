import { describe, expect, it } from "@effect/vitest";

import {
  cursorMotionPlan,
  cursorTravelMs,
  minimumJerkSample,
  springRetargetSample,
} from "./cursorMotion";

describe("cursor motion", () => {
  it("150–450 ms Fitts clamp and sub-four-pixel snap bound glide", () => {
    expect(cursorTravelMs({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(0);
    expect(cursorTravelMs({ x: 0, y: 0 }, { x: 4, y: 0 })).toBeGreaterThanOrEqual(150);
    expect(cursorTravelMs({ x: 0, y: 0 }, { x: 100_000, y: 0 })).toBe(450);
  });

  it("minimum-jerk ends with zero velocity and acceleration", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: 100 };
    expect(minimumJerkSample(from, to, 0, 300)).toEqual({ ...from, vx: 0, vy: 0 });
    expect(minimumJerkSample(from, to, 300, 300)).toEqual({ ...to, vx: 0, vy: 0 });
    expect(minimumJerkSample(from, to, 150, 300).x).toBeCloseTo(150);
    const nearEnd = minimumJerkSample(from, to, 299.99, 300);
    expect(nearEnd.vx).toBeGreaterThanOrEqual(0);
    expect(nearEnd.vx).toBeLessThan(0.000001);
  });

  it("critical retarget starts at current position and settles by 600 ms without overshoot", () => {
    const from = { x: 125, y: 40, vx: 0.3, vy: 0 };
    const to = { x: 300, y: 40 };
    expect(springRetargetSample(from, to, 0)).toEqual(from);
    for (const time of [50, 100, 250, 400, 599]) {
      const sample = springRetargetSample(from, to, time);
      expect(sample.x).toBeGreaterThanOrEqual(from.x);
      expect(sample.x).toBeLessThanOrEqual(to.x);
    }
    expect(springRetargetSample(from, to, 600)).toEqual({ ...to, vx: 0, vy: 0 });
  });

  it("reduced-motion plan teleports and fades without travel", () => {
    expect(cursorMotionPlan(true, { x: 0, y: 0 }, { x: 300, y: 0 })).toEqual({
      kind: "teleport",
      durationMs: 100,
    });
  });
});

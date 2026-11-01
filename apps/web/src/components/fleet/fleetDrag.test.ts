import { describe, expect, it } from "vite-plus/test";

import { rubberBand, stepSpring, type FleetSpring } from "./fleetDrag";

describe("rubberBand", () => {
  it("keeps the pull's direction and never passes its reach", () => {
    const eased = rubberBand({ x: 3000, y: -4000 }, 120);
    expect(Math.hypot(eased.x, eased.y)).toBeLessThanOrEqual(120);
    expect(eased.x / eased.y).toBeCloseTo(-0.75);
    const small = rubberBand({ x: 10, y: 0 }, 120);
    expect(small.x).toBeGreaterThan(9);
  });
});

describe("stepSpring", () => {
  it("overshoots once released, then settles at rest", () => {
    let spring: FleetSpring | null = { offset: { x: 100, y: 0 }, velocity: { x: 0, y: 0 } };
    let crossed = false;
    let steps = 0;
    while (spring !== null && steps < 600) {
      spring = stepSpring(spring, 1 / 60);
      if (spring !== null && spring.offset.x < 0) crossed = true;
      steps += 1;
    }
    expect(spring).toBeNull();
    expect(crossed).toBe(true);
    expect(steps).toBeLessThan(180);
  });
});

export interface CursorPoint {
  readonly x: number;
  readonly y: number;
}

export interface CursorSample extends CursorPoint {
  readonly vx: number;
  readonly vy: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function cursorTravelMs(from: CursorPoint, to: CursorPoint, targetWidth = 16): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 4) return 0;
  return clamp(150 + 75 * Math.log2(1 + distance / Math.max(1, targetWidth)), 150, 450);
}

export function minimumJerkSample(
  from: CursorPoint,
  to: CursorPoint,
  elapsedMs: number,
  durationMs: number,
): CursorSample {
  const t = durationMs <= 0 ? 1 : clamp(elapsedMs / durationMs, 0, 1);
  const progress = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
  const derivative = durationMs <= 0 ? 0 : (30 * t ** 2 - 60 * t ** 3 + 30 * t ** 4) / durationMs;
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    vx: (to.x - from.x) * derivative,
    vy: (to.y - from.y) * derivative,
  };
}

/** A damped retarget starts at the presentation position and velocity, then snaps at 600 ms. */
export function springRetargetSample(
  from: CursorSample,
  to: CursorPoint,
  elapsedMs: number,
): CursorSample {
  if (elapsedMs >= 600) return { ...to, vx: 0, vy: 0 };
  const t = Math.max(0, elapsedMs) / 1000;
  const omega = 18;
  const axis = (position: number, velocity: number, target: number) => {
    const delta = position - target;
    const velocityPerSecond = velocity * 1000;
    const coefficient = velocityPerSecond + omega * delta;
    const decay = Math.exp(-omega * t);
    const raw = target + (delta + coefficient * t) * decay;
    const value = clamp(raw, Math.min(position, target), Math.max(position, target));
    return {
      value,
      velocity: value === raw ? ((velocityPerSecond - omega * coefficient * t) * decay) / 1000 : 0,
    };
  };
  const x = axis(from.x, from.vx, to.x);
  const y = axis(from.y, from.vy, to.y);
  return { x: x.value, y: y.value, vx: x.velocity, vy: y.velocity };
}

export function cursorMotionPlan(reducedMotion: boolean, from: CursorPoint, to: CursorPoint) {
  return reducedMotion
    ? { kind: "teleport" as const, durationMs: 100 }
    : { kind: "glide" as const, durationMs: cursorTravelMs(from, to) };
}

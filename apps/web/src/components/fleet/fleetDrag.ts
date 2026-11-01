/**
 * Pull-and-release motion for the fleet graph: a dragged node resists more the
 * farther it goes, then springs back to its orbit when let go.
 */

export interface FleetVector {
  readonly x: number;
  readonly y: number;
}

export const ZERO_VECTOR: FleetVector = { x: 0, y: 0 };

/** Eases a raw pull so the node approaches \`reach\` but never passes it. */
export function rubberBand(pull: FleetVector, reach: number): FleetVector {
  const distance = Math.hypot(pull.x, pull.y);
  if (distance === 0) return ZERO_VECTOR;
  const eased = reach * (1 - Math.exp(-distance / reach));
  return { x: (pull.x / distance) * eased, y: (pull.y / distance) * eased };
}

export interface FleetSpring {
  readonly offset: FleetVector;
  readonly velocity: FleetVector;
}

const STIFFNESS = 180;
const DAMPING = 11;

/** Advances a damped spring toward rest; null once it has settled. */
export function stepSpring(spring: FleetSpring, seconds: number): FleetSpring | null {
  const dt = Math.min(seconds, 1 / 30);
  const vx = spring.velocity.x + (-STIFFNESS * spring.offset.x - DAMPING * spring.velocity.x) * dt;
  const vy = spring.velocity.y + (-STIFFNESS * spring.offset.y - DAMPING * spring.velocity.y) * dt;
  const x = spring.offset.x + vx * dt;
  const y = spring.offset.y + vy * dt;
  if (Math.hypot(x, y) < 0.3 && Math.hypot(vx, vy) < 4) return null;
  return { offset: { x, y }, velocity: { x: vx, y: vy } };
}

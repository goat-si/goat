/**
 * How a round avatar draws its waiting dot, in px, from the avatar circle's diameter. Web and
 * mobile share these numbers so the two clients agree.
 */
const GOAT_BOT_WAITING_DOT = {
  /** The dot's share of the circle, kept between 6 and 10 px. */
  ratio: 0.28,
  min: 6,
  max: 10,
  /**
   * Below this circle the head reaches the dot's corner, so the dot sits one px further out and
   * its ring is a hairline; from here up it sits on the corner with a wider ring.
   */
  smallBelow: 32,
  out: 1,
  ring: { small: 1, large: 1.5 },
} as const;

/** Where the waiting dot goes in an avatar circle of this diameter, in px. */
export interface GoatBotWaitingDotGeometry {
  /** The dot itself, without its ring. */
  readonly size: number;
  /** The ring in the colour behind the avatar, which parts the dot from a member's colour. */
  readonly ring: number;
  /** The dot with its ring: the box the caller draws. */
  readonly box: number;
  /** The box's inset from the circle's top and right edges; negative hangs it past them. */
  readonly inset: number;
}

export function goatBotWaitingDot(circle: number): GoatBotWaitingDotGeometry {
  const { ratio, min, max, smallBelow, out, ring } = GOAT_BOT_WAITING_DOT;
  const size = Math.min(max, Math.max(min, Math.round(circle * ratio)));
  const small = circle < smallBelow;
  const ringPx = small ? ring.small : ring.large;
  return { size, ring: ringPx, box: size + ringPx * 2, inset: -((small ? out : 0) + ringPx) };
}

/**
 * Bot face poses per mood, and the blend between moods.
 *
 * Lifted from NousResearch/hermes-agent apps/desktop/src/plugins/hermes-bots/avatar.tsx (MIT),
 * functions `facePose` and `settlePose`. Hermes has three moods (idle | think | work). GOAT 2 adds
 * ack, needs_you, done and error on top, mapped to the ledger states in docs/MOTION.md.
 */

export type BotMood = "idle" | "ack" | "think" | "work" | "needs_you" | "done" | "error";

/** One frame of the face: head orientation, gaze offset, blink, and the three working dots. */
export interface FacePose {
  blink: boolean;
  d0: number;
  d1: number;
  d2: number;
  gazeX: number;
  gazeY: number;
  roll: number;
  tilt: number;
  turn: number;
  /** GOAT 2 additions: vertical hop in px and eye shape. */
  hop: number;
  eyes: "open" | "happy" | "shut";
}

const STILL: FacePose = { turn: 0, tilt: 0, roll: 0, gazeX: 0, gazeY: 0, blink: false, d0: 0, d1: 0, d2: 0, hop: 0, eyes: "open" };

/** Working poses lean and sway; idle stays small. `t` is seconds on the shared face clock;
 *  `since` is seconds since this mood began (for one-shot moods). */
export function facePose(mood: BotMood, t: number, since = Number.POSITIVE_INFINITY): FacePose {
  if (mood === "think") {
    // hermes `think`, unchanged
    return {
      ...STILL,
      turn: -18 + Math.sin(t * 0.55) * 14,
      tilt: Math.sin(t * 0.48) * 12 + Math.sin(t * 1.35) * 3,
      roll: Math.sin(t * 0.95) * 10,
      gazeX: Math.sin(t * 0.7) * 3.6,
      gazeY: -2.2 + Math.sin(t * 0.4) * 2.2,
      blink: t % 1.45 > 1.26,
      d0: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.4)),
      d1: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.4 - 0.7)),
      d2: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.4 - 1.4)),
    };
  }
  if (mood === "work") {
    // hermes `work`, unchanged
    return {
      ...STILL,
      turn: -11 + Math.sin(t * 0.48) * 8,
      tilt: Math.sin(t * 0.42) * 8 + Math.sin(t * 1.1) * 1.6,
      roll: Math.sin(t * 0.75) * 4.2,
      gazeX: Math.sin(t * 0.55) * 3.6,
      gazeY: -1.6 + Math.sin(t * 0.38) * 2,
      blink: t % 1.45 > 1.26,
      d0: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.6)),
      d1: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.6 - 0.7)),
      d2: 0.2 + 0.8 * Math.max(0, Math.sin(t * 2.6 - 1.4)),
    };
  }
  if (mood === "ack") {
    // GOAT 2: one nod (down-up) over 0.32s when work arrives, then holds forward.
    const p = Math.min(1, since / 0.32);
    return { ...STILL, tilt: Math.sin(p * Math.PI) * 10, gazeY: 1 };
  }
  if (mood === "needs_you") {
    // GOAT 2: faces the person, no sway. One small hop every 4s so it is noticed, never a loop of bounces.
    const c = t % 4;
    const hop = c < 0.36 ? Math.sin((c / 0.36) * Math.PI) * 2.5 : 0;
    return { ...STILL, gazeY: 1.2, blink: t % 3.2 > 3.02, hop };
  }
  if (mood === "done") {
    // GOAT 2: happy eyes for 1.2s, then the caller switches the mood back to idle.
    return { ...STILL, eyes: since < 1.2 ? "happy" : "open", blink: false };
  }
  if (mood === "error") {
    // GOAT 2: still, eyes shut. The label carries the reason; nothing moves.
    return { ...STILL, eyes: "shut" };
  }
  // hermes `idle`, unchanged
  return {
    ...STILL,
    turn: Math.sin(t * 0.5) * 1.5,
    tilt: Math.sin(t * 0.27),
    roll: Math.sin(t * 0.85) * 1.2,
    blink: t % 3.2 > 3.02,
  };
}

const NUMERIC = ["turn", "tilt", "roll", "gazeX", "gazeY", "d0", "d1", "d2", "hop"] as const;

/** Blend from the last painted pose over `blendSeconds` with an ease-out quad (hermes settlePose). */
export function blendPose(from: FacePose, target: FacePose, elapsed: number, blendSeconds = 0.4): FacePose {
  const progress = Math.min(1, Math.max(0, elapsed / blendSeconds));
  const k = 1 - (1 - progress) ** 2;
  const out: FacePose = { ...target };
  for (const key of NUMERIC) out[key] = from[key] + (target[key] - from[key]) * k;
  return out;
}

/** Under prefers-reduced-motion the face is drawn still in every mood; state is carried by glyph + label. */
export function reducedPose(mood: BotMood): FacePose {
  return { ...STILL, eyes: mood === "error" ? "shut" : mood === "done" ? "happy" : "open" };
}

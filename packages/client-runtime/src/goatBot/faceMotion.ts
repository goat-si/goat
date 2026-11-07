import type { GoatBotFaceState } from "./face.ts";

/**
 * One frame of a face's eye motion: when in the cycle (0..1), the eyes' sideways shift in face
 * units (the mark's 24-unit grid, 20 across the face) and their vertical scale.
 */
export interface FaceMotionFrame {
  readonly at: number;
  readonly x: number;
  readonly scaleY: number;
}

export interface FaceMotion {
  readonly cycleMs: number;
  readonly frames: ReadonlyArray<FaceMotionFrame>;
}

/**
 * Reading sweeps the eyes across a line and returns; working blinks, then glances aside. Each
 * holds still for most of its cycle, as the running-thread shimmer does.
 */
const FACE_MOTION: Partial<Record<GoatBotFaceState, FaceMotion>> = {
  reading: {
    cycleMs: 2_600,
    frames: [
      { at: 0, x: 0, scaleY: 1 },
      { at: 0.12, x: -0.8, scaleY: 1 },
      { at: 0.3, x: 0.8, scaleY: 1 },
      { at: 0.36, x: 0, scaleY: 1 },
      { at: 1, x: 0, scaleY: 1 },
    ],
  },
  working: {
    cycleMs: 3_200,
    frames: [
      { at: 0, x: 0, scaleY: 1 },
      { at: 0.04, x: 0, scaleY: 0.15 },
      { at: 0.08, x: 0, scaleY: 1 },
      { at: 0.5, x: 0, scaleY: 1 },
      { at: 0.56, x: 0.9, scaleY: 1 },
      { at: 0.66, x: 0.9, scaleY: 1 },
      { at: 0.72, x: 0, scaleY: 1 },
      { at: 1, x: 0, scaleY: 1 },
    ],
  },
};

/** The eye motion for a state; null for the still ones. */
export function goatBotFaceMotion(state: GoatBotFaceState): FaceMotion | null {
  return FACE_MOTION[state] ?? null;
}

/** How much of a cycle the eyes hold still. */
export function faceMotionStillFraction(motion: FaceMotion): number {
  let still = 0;
  for (let index = 1; index < motion.frames.length; index++) {
    const previous = motion.frames[index - 1];
    const frame = motion.frames[index];
    if (previous === undefined || frame === undefined) continue;
    if (previous.x === frame.x && previous.scaleY === frame.scaleY) still += frame.at - previous.at;
  }
  return still;
}

/** A face may move only in a moving state while someone can see it and has not asked for less motion. */
export function faceMotionEligible(input: {
  readonly state: GoatBotFaceState;
  readonly visible: boolean;
  readonly active: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return (
    goatBotFaceMotion(input.state) !== null && input.visible && input.active && !input.reducedMotion
  );
}

/** Where a face sits; a higher rank takes the one motion a screen allows. */
export const FACE_MOTION_RANK = { rail: 0, list: 1, header: 2 } as const;

/**
 * At most one face moves on a screen. The highest rank wins, then the most recently started
 * work (a face without a start time ranks below any timed one), then the newest claim.
 * Pattern of apps/mobile/src/features/threads/work-shimmer-arbiter.ts.
 */
export interface FaceMotionArbiter {
  readonly claim: (label: number, rank: number, since: number | null) => void;
  readonly release: (label: number) => void;
  readonly owner: () => number | null;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createFaceMotionArbiter(): FaceMotionArbiter {
  const claims = new Map<
    number,
    { readonly rank: number; readonly since: number; readonly seq: number }
  >();
  const listeners = new Set<() => void>();
  let seq = 0;
  let owner: number | null = null;
  const beats = (
    a: { readonly rank: number; readonly since: number; readonly seq: number },
    b: { readonly rank: number; readonly since: number; readonly seq: number },
  ) =>
    a.rank !== b.rank ? a.rank > b.rank : a.since !== b.since ? a.since > b.since : a.seq > b.seq;
  const settle = () => {
    let next: number | null = null;
    let best: { readonly rank: number; readonly since: number; readonly seq: number } | null = null;
    for (const [label, entry] of claims) {
      if (best === null || beats(entry, best)) {
        next = label;
        best = entry;
      }
    }
    if (next === owner) return;
    owner = next;
    for (const listener of listeners) listener();
  };
  return {
    claim: (label, rank, since) => {
      seq += 1;
      claims.set(label, { rank, since: since ?? Number.NEGATIVE_INFINITY, seq });
      settle();
    },
    release: (label) => {
      if (claims.delete(label)) settle();
    },
    owner: () => owner,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

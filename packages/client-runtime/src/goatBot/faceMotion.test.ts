import { describe, expect, it } from "vite-plus/test";

import type { GoatBotFaceState } from "./face.ts";
import {
  FACE_MOTION_RANK,
  createFaceMotionArbiter,
  faceMotionEligible,
  faceMotionStillFraction,
  goatBotFaceMotion,
} from "./faceMotion.ts";

const ALL: ReadonlyArray<GoatBotFaceState> = [
  "idle",
  "reading",
  "working",
  "waiting",
  "failed",
  "finished",
  "sleeping",
];

describe("goatBotFaceMotion", () => {
  it("moves only while reading or working", () => {
    expect(ALL.filter((state) => goatBotFaceMotion(state) !== null)).toEqual([
      "reading",
      "working",
    ]);
  });

  it("holds still for at least half of every cycle", () => {
    for (const state of ALL) {
      const motion = goatBotFaceMotion(state);
      if (motion !== null) expect(faceMotionStillFraction(motion)).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe("faceMotionEligible", () => {
  const visible = { visible: true, active: true, reducedMotion: false } as const;

  it("lets a working face move while it is seen", () => {
    expect(faceMotionEligible({ state: "working", ...visible })).toBe(true);
  });

  it("keeps the face still under reduce motion, off screen or in the background", () => {
    expect(faceMotionEligible({ state: "working", ...visible, reducedMotion: true })).toBe(false);
    expect(faceMotionEligible({ state: "working", ...visible, visible: false })).toBe(false);
    expect(faceMotionEligible({ state: "reading", ...visible, active: false })).toBe(false);
  });

  it("never moves a still state", () => {
    expect(faceMotionEligible({ state: "finished", ...visible })).toBe(false);
  });
});

describe("createFaceMotionArbiter", () => {
  it("gives the motion to the chat header over the list and the rail", () => {
    const arbiter = createFaceMotionArbiter();
    arbiter.claim(1, FACE_MOTION_RANK.rail, 0);
    arbiter.claim(2, FACE_MOTION_RANK.header, 0);
    arbiter.claim(3, FACE_MOTION_RANK.list, 0);
    expect(arbiter.owner()).toBe(2);
  });

  it("moves the list face whose work started most recently", () => {
    const arbiter = createFaceMotionArbiter();
    arbiter.claim(1, FACE_MOTION_RANK.list, 2_000);
    arbiter.claim(2, FACE_MOTION_RANK.list, 1_000);
    expect(arbiter.owner()).toBe(1);
  });

  it("ranks a face without a start time below a timed one, then by newest claim", () => {
    const arbiter = createFaceMotionArbiter();
    arbiter.claim(1, FACE_MOTION_RANK.list, 1_000);
    arbiter.claim(2, FACE_MOTION_RANK.list, null);
    expect(arbiter.owner()).toBe(1);
    arbiter.release(1);
    arbiter.claim(3, FACE_MOTION_RANK.list, null);
    expect(arbiter.owner()).toBe(3);
  });

  it("hands the motion on when the owner stops and tells listeners once", () => {
    const arbiter = createFaceMotionArbiter();
    const changes: Array<number | null> = [];
    arbiter.subscribe(() => changes.push(arbiter.owner()));
    arbiter.claim(1, FACE_MOTION_RANK.header, 0);
    arbiter.claim(2, FACE_MOTION_RANK.list, 0);
    arbiter.release(1);
    arbiter.release(2);
    expect(changes).toEqual([1, 2, null]);
  });
});

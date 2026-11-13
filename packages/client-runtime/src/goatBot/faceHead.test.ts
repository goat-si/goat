import { describe, expect, it } from "vite-plus/test";

import type { GoatBotFaceState } from "./face.ts";
import { goatBotAvatarSignal } from "./avatar.ts";
import {
  GOAT_BOT_HEAD_SLEEP_MARK_PATH,
  GOAT_BOT_HEAD_SLEEP_MARK_STROKE_WIDTH,
  goatBotHeadArt,
} from "./faceHead.ts";
import {
  closest,
  MOBILE_HEAD_RATIO,
  rightEarAndHorn,
  strokeOutline,
  WEB_AVATAR_SIZES,
  zInnerGap,
} from "./faceGeometry.testkit.ts";

const STATES: ReadonlyArray<GoatBotFaceState> = [
  "idle",
  "reading",
  "working",
  "waiting",
  "failed",
  "finished",
  "sleeping",
];

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The on-curve points of each shape in a path, plus each curve's control point. */
function shapesOf(path: string): Array<{ points: Point[]; controls: Point[]; radius: number }> {
  const shapes: Array<{ points: Point[]; controls: Point[]; radius: number }> = [];
  const tokens = path.match(/[MLAQHZ]|-?\d*\.?\d+/g) ?? [];
  let index = 0;
  let current: Point = { x: 0, y: 0 };
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = tokens[index++];
    const shape = shapes.at(-1);
    if (command === "M") {
      current = { x: next(), y: next() };
      shapes.push({ points: [current], controls: [], radius: 0 });
    } else if (command === "L") {
      current = { x: next(), y: next() };
      shape?.points.push(current);
    } else if (command === "A") {
      if (shape !== undefined) shape.radius = next();
      index += 4;
      current = { x: next(), y: next() };
      shape?.points.push(current);
    } else if (command === "Q") {
      shape?.controls.push({ x: next(), y: next() });
      current = { x: next(), y: next() };
      shape?.points.push(current);
    } else if (command === "H") {
      current = { x: next(), y: current.y };
      shape?.points.push(current);
    }
  }
  return shapes;
}

const extent = (points: ReadonlyArray<Point>) => {
  const ys = points.map((point) => point.y);
  const xs = points.map((point) => point.x);
  return {
    height: Math.max(...ys) - Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    centreX: (Math.max(...xs) + Math.min(...xs)) / 2,
    centreY: (Math.max(...ys) + Math.min(...ys)) / 2,
  };
};

/** A capsule's length along its axis (cap to cap) and its width (one diameter). */
const capsule = (shape: { points: ReadonlyArray<Point>; radius: number }) => {
  const [a, b, c, d] = shape.points;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error("a capsule has four corners");
  }
  const top = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const bottom = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
  return {
    height: Math.hypot(top.x - bottom.x, top.y - bottom.y) + 2 * shape.radius,
    width: 2 * shape.radius,
    centreY: (top.y + bottom.y) / 2,
  };
};

const FACE_CENTRE_X = 12;
const eyes = (state: GoatBotFaceState) => shapesOf(goatBotHeadArt(state).eyes);
const strokes = (state: GoatBotFaceState) => shapesOf(goatBotHeadArt(state).strokes);

describe("goatBotHeadArt: each face state maps to its own eyes", () => {
  it("draws two eyes in every state, and the seven drawings all differ", () => {
    for (const state of STATES) expect(eyes(state).length + strokes(state).length, state).toBe(2);
    const drawings = new Set(STATES.map((state) => JSON.stringify(goatBotHeadArt(state))));
    expect(drawings.size).toBe(STATES.length);
  });

  it("idle eyes are open capsules, taller than they are wide", () => {
    expect(strokes("idle")).toEqual([]);
    for (const eye of eyes("idle")) {
      const size = capsule(eye);
      expect(size.height).toBeGreaterThan(size.width * 1.5);
    }
  });

  it("reading eyes look down: lower and smaller than idle", () => {
    const idle = eyes("idle").map(capsule);
    const reading = eyes("reading").map(capsule);
    reading.forEach((box, side) => {
      expect(box.centreY).toBeGreaterThan(idle[side]?.centreY ?? Infinity);
      expect(box.height).toBeLessThan(idle[side]?.height ?? 0);
    });
  });

  it("working eyes are about half as tall as idle", () => {
    const idle = eyes("idle").map(capsule);
    eyes("working").forEach((eye, side) => {
      expect(capsule(eye).height).toBeLessThan((idle[side]?.height ?? 0) * 0.6);
    });
  });

  it("waiting winks the left eye and keeps the right one open", () => {
    const [wink] = strokes("waiting");
    const [open] = eyes("waiting");
    expect(extent(wink?.points ?? []).centreX).toBeLessThan(FACE_CENTRE_X);
    expect(extent(open?.points ?? []).centreX).toBeGreaterThan(FACE_CENTRE_X);
  });

  it("failed eyes are dashes sloping down toward the outside of the face", () => {
    expect(eyes("failed")).toEqual([]);
    for (const dash of strokes("failed")) {
      const [start, end] = dash.points;
      if (start === undefined || end === undefined) throw new Error("a dash has two ends");
      const outer =
        Math.abs(start.x - FACE_CENTRE_X) > Math.abs(end.x - FACE_CENTRE_X) ? start : end;
      const inner = outer === start ? end : start;
      expect(outer.y).toBeGreaterThan(inner.y);
    }
  });

  it("finished eyes are happy arcs that bow upward", () => {
    expect(eyes("finished")).toEqual([]);
    for (const arc of strokes("finished")) {
      const [bend] = arc.controls;
      for (const end of arc.points) expect(bend?.y ?? Infinity).toBeLessThan(end.y);
    }
  });

  it("sleeping eyes are flat lines, with the sleep mark only while sleeping", () => {
    expect(eyes("sleeping")).toEqual([]);
    for (const line of strokes("sleeping")) expect(extent(line.points).height).toBe(0);
    for (const state of STATES)
      expect(goatBotHeadArt(state).sleepMark, state).toBe(state === "sleeping");
  });
});

describe("goatBotHeadArt: the sleep mark stays in the avatar and clear of the head", () => {
  const mark = strokeOutline(GOAT_BOT_HEAD_SLEEP_MARK_PATH, GOAT_BOT_HEAD_SLEEP_MARK_STROKE_WIDTH);

  it("keeps the z's bars apart, so it still reads as a z at 20 px", () => {
    // 0.65 units is what the mark left open before it had to fit inside the 20 px circle.
    expect(
      zInnerGap(GOAT_BOT_HEAD_SLEEP_MARK_PATH, GOAT_BOT_HEAD_SLEEP_MARK_STROKE_WIDTH),
    ).toBeGreaterThanOrEqual(0.65);
  });

  it.each(WEB_AVATAR_SIZES)(
    "draws its whole stroke inside the $circle px circle",
    ({ circle, head }) => {
      // The circle's radius in the head's 20-unit art box, around the box's centre (12, 12).
      const radius = (10 * circle) / head;
      const farthest = Math.max(...mark.map((point) => Math.hypot(point.x - 12, point.y - 12)));
      expect(radius - farthest).toBeGreaterThan(0.2);
    },
  );

  it("draws its whole stroke inside mobile's circle, where the head is 0.86 of it", () => {
    const radius = 10 / MOBILE_HEAD_RATIO;
    const farthest = Math.max(...mark.map((point) => Math.hypot(point.x - 12, point.y - 12)));
    expect(radius - farthest).toBeGreaterThan(0.2);
  });

  it("keeps its stroke off the right horn and the right ear", () => {
    const { ear, horn } = rightEarAndHorn();
    expect(closest(mark, horn)).toBeGreaterThan(0.4);
    expect(closest(mark, ear)).toBeGreaterThan(0.4);
  });

  it("never shares a face with the waiting dot, which sits in the same corner", () => {
    for (const state of STATES)
      for (const emoji of [false, true])
        expect(
          goatBotHeadArt(state).sleepMark && goatBotAvatarSignal(state, emoji).waitingDot,
        ).toBe(false);
  });
});

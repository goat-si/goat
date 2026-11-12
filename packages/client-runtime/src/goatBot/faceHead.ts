import type { GoatBotFaceState } from "./face.ts";

/**
 * GOAT Bot's head (direction C): a solid goat head with eyes on their own layer. It shares the
 * goat mark's 20-unit box, so faceMotion's sideways units hold.
 */
export const GOAT_BOT_HEAD_VIEWBOX = "2 2 20 20";

/** Face, ears and horns as one filled shape; every subpath runs clockwise so they merge. */
export const GOAT_BOT_HEAD_PATH = [
  "M5.5 13 a6.5 7.1 0 1 1 13 0 a6.5 7.1 0 1 1 -13 0 Z",
  "M6.3 10.6 C5.3 11.05 4.3 11.35 3.5 11.25 C3.1 11.2 2.75 11.05 2.8 10.7 C3 9.6 3.9 8.3 5.4 7.18 C6.3 6.6 7.5 6.35 9.3 6.45 Z",
  "M14.7 6.45 C16.5 6.35 17.7 6.6 18.6 7.18 C20.1 8.3 21 9.6 21.2 10.7 C21.25 11.05 20.9 11.2 20.5 11.25 C19.7 11.35 18.7 11.05 17.7 10.6 Z",
  "M8.8 7.2 C8.75 5.9 8.95 4.8 9.6 3.9 C10.25 4.6 10.7 5.5 11 6.7 Z",
  "M13 6.7 C13.3 5.5 13.75 4.6 14.4 3.9 C15.05 4.8 15.25 5.9 15.2 7.2 Z",
].join(" ");

export const GOAT_BOT_HEAD_STROKE_WIDTH = 1.35;
/** A small "z" beside the right horn, inside the avatar circle at every size. */
export const GOAT_BOT_HEAD_SLEEP_MARK_PATH = "M16.3 3.4 H18.3 L16.3 5.4 H18.3";
/** The eye line (y 12.4 in the 2..22 box); a blink scales around it. */
export const GOAT_BOT_HEAD_EYES_ORIGIN = "50% 52%";

/** How a state draws its eyes in the eye colour: filled shapes and stroked lines, either may be "". */
export interface GoatBotHeadArt {
  readonly eyes: string;
  readonly strokes: string;
  readonly sleepMark: boolean;
}

const LEFT = 8.9;
const RIGHT = 15.1;
const EYE_Y = 12.4;
const HALF_WIDTH = 0.9;
const HALF_HEIGHT = 1.85;
/** Degrees the eyes' tops lean toward each other. */
const LEAN = 6;

const n = (value: number) => Number(value.toFixed(3));

/** A tall capsule centred on (x, y), its top turned by tilt degrees (positive leans right). */
function capsule(x: number, y: number, halfWidth: number, halfHeight: number, tilt: number) {
  const angle = (tilt * Math.PI) / 180;
  const up = { x: Math.sin(angle), y: -Math.cos(angle) };
  const side = { x: Math.cos(angle), y: Math.sin(angle) };
  const reach = Math.max(0, halfHeight - halfWidth);
  const top = { x: x + up.x * reach, y: y + up.y * reach };
  const bottom = { x: x - up.x * reach, y: y - up.y * reach };
  const r = halfWidth;
  return (
    "M" +
    n(top.x - side.x * r) +
    " " +
    n(top.y - side.y * r) +
    " A" +
    r +
    " " +
    r +
    " 0 0 1 " +
    n(top.x + side.x * r) +
    " " +
    n(top.y + side.y * r) +
    " L" +
    n(bottom.x + side.x * r) +
    " " +
    n(bottom.y + side.y * r) +
    " A" +
    r +
    " " +
    r +
    " 0 0 1 " +
    n(bottom.x - side.x * r) +
    " " +
    n(bottom.y - side.y * r) +
    " Z"
  );
}

function eyePair(halfWidth: number, halfHeight: number, drop: number): string {
  return (
    capsule(LEFT, EYE_Y + drop, halfWidth, halfHeight, LEAN) +
    " " +
    capsule(RIGHT, EYE_Y + drop, halfWidth, halfHeight, -LEAN)
  );
}

/** An arc across an eye; a negative bend bows it upward. */
function arc(x: number, y: number, halfSpan: number, bend: number): string {
  return (
    "M" +
    n(x - halfSpan) +
    " " +
    n(y) +
    " Q" +
    n(x) +
    " " +
    n(y + bend) +
    " " +
    n(x + halfSpan) +
    " " +
    n(y)
  );
}

const HEAD_ART: Record<GoatBotFaceState, GoatBotHeadArt> = {
  idle: { eyes: eyePair(HALF_WIDTH, HALF_HEIGHT, 0), strokes: "", sleepMark: false },
  // Looking down at what it reads; the sweep is faceMotion's.
  reading: { eyes: eyePair(0.81, 1.48, 0.7), strokes: "", sleepMark: false },
  working: { eyes: eyePair(HALF_WIDTH, 1.02, 0.3), strokes: "", sleepMark: false },
  waiting: {
    eyes: capsule(RIGHT, EYE_Y, HALF_WIDTH, HALF_HEIGHT, -LEAN),
    strokes: arc(LEFT, EYE_Y + 0.6, 1.4, -1.8),
    sleepMark: false,
  },
  failed: {
    eyes: "",
    strokes:
      "M" +
      n(LEFT + 1.2) +
      " " +
      n(EYE_Y - 0.3) +
      " L" +
      n(LEFT - 1.2) +
      " " +
      n(EYE_Y + 0.8) +
      " M" +
      n(RIGHT - 1.2) +
      " " +
      n(EYE_Y - 0.3) +
      " L" +
      n(RIGHT + 1.2) +
      " " +
      n(EYE_Y + 0.8),
    sleepMark: false,
  },
  finished: {
    eyes: "",
    strokes: arc(LEFT, EYE_Y + 0.9, 1.4, -2.4) + " " + arc(RIGHT, EYE_Y + 0.9, 1.4, -2.4),
    sleepMark: false,
  },
  sleeping: {
    eyes: "",
    strokes:
      "M" +
      n(LEFT - 1.3) +
      " " +
      n(EYE_Y + 0.4) +
      " H" +
      n(LEFT + 1.3) +
      " M" +
      n(RIGHT - 1.3) +
      " " +
      n(EYE_Y + 0.4) +
      " H" +
      n(RIGHT + 1.3),
    sleepMark: true,
  },
};

export function goatBotHeadArt(state: GoatBotFaceState): GoatBotHeadArt {
  return HEAD_ART[state];
}

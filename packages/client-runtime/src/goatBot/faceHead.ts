import type { GoatBotFaceState } from "./face.ts";

/**
 * GOAT Bot's head (direction C): a solid goat head with eyes on their own layer. It shares the
 * goat mark's 20-unit box, so faceMotion's sideways units hold.
 */
export const GOAT_BOT_HEAD_VIEWBOX = "2 2 20 20";

/** Face, ears and horns as one filled shape; every subpath runs clockwise so they merge. */
export const GOAT_BOT_HEAD_PATH = [
  "M5.5 13 a6.5 7.1 0 1 1 13 0 a6.5 7.1 0 1 1 -13 0 Z",
  "M6.2 10.4 C5.7 11.2 4.9 12.1 4 12.4 C3.5 12.55 2.95 12.4 2.75 11.9 C2.55 11.4 2.75 10.6 3.1 10 C3.7 9 4.9 8.1 6 7.6 C6.8 7.25 7.6 7.05 8.6 7.1 Z",
  "M15.4 7.1 C16.4 7.05 17.2 7.25 18 7.6 C19.1 8.1 20.3 9 20.9 10 C21.25 10.6 21.45 11.4 21.25 11.9 C21.05 12.4 20.5 12.55 20 12.4 C19.1 12.1 18.3 11.2 17.8 10.4 Z",
  "M8.3 7.8 C8.1 6.2 8.3 4.7 9 3.6 C9.8 4.5 10.5 5.6 10.9 6.9 Z",
  "M13.1 6.9 C13.5 5.6 14.2 4.5 15 3.6 C15.7 4.7 15.9 6.2 15.7 7.8 Z",
].join(" ");

export const GOAT_BOT_HEAD_STROKE_WIDTH = 1.35;
/**
 * A small "z" beside the right horn, inside the avatar circle at every size (the 20 px circle's
 * 18 px head is the tightest case). Its own stroke is thinner than the eyes' so its bars stay
 * apart and it reads as a z at 20 px.
 */
export const GOAT_BOT_HEAD_SLEEP_MARK_PATH = "M16.8 4.2 H18.7 L16.8 6.1 H18.7";
export const GOAT_BOT_HEAD_SLEEP_MARK_STROKE_WIDTH = 1;
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

import { GOAT_BOT_HEAD_PATH } from "./faceHead.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

const at = (x: number, y: number): Point => ({ x, y });

/**
 * Flattens each subpath of an SVG path into points, absolute or relative commands alike. Arcs are
 * the half ellipses the head and eyes draw, so each arc's centre is the middle of its ends.
 */
function flattenPath(path: string, steps = 64): Point[][] {
  const tokens = path.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const parts: Point[][] = [];
  let index = 0;
  let current = at(0, 0);
  let start = current;
  const next = () => Number(tokens[index++]);
  const push = (point: Point) => parts.at(-1)?.push(point);
  while (index < tokens.length) {
    const command = tokens[index++] ?? "";
    const base = command === command.toLowerCase() ? current : at(0, 0);
    switch (command.toUpperCase()) {
      case "M":
        current = at(base.x + next(), base.y + next());
        start = current;
        parts.push([current]);
        break;
      case "L":
        current = at(base.x + next(), base.y + next());
        push(current);
        break;
      case "H":
        current = at(base.x + next(), current.y);
        push(current);
        break;
      case "V":
        current = at(current.x, base.y + next());
        push(current);
        break;
      case "Z":
        current = start;
        push(current);
        break;
      case "C": {
        const from = current;
        const first = at(base.x + next(), base.y + next());
        const second = at(base.x + next(), base.y + next());
        current = at(base.x + next(), base.y + next());
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          const u = 1 - t;
          push(
            at(
              u ** 3 * from.x +
                3 * u * u * t * first.x +
                3 * u * t * t * second.x +
                t ** 3 * current.x,
              u ** 3 * from.y +
                3 * u * u * t * first.y +
                3 * u * t * t * second.y +
                t ** 3 * current.y,
            ),
          );
        }
        break;
      }
      case "A": {
        const radiusX = next();
        const radiusY = next();
        index += 3;
        const to = at(base.x + next(), base.y + next());
        const centre = at((current.x + to.x) / 2, (current.y + to.y) / 2);
        const from = Math.atan2((current.y - centre.y) / radiusY, (current.x - centre.x) / radiusX);
        for (let step = 1; step <= steps; step += 1) {
          const angle = from + (Math.PI * step) / steps;
          push(at(centre.x + radiusX * Math.cos(angle), centre.y + radiusY * Math.sin(angle)));
        }
        current = to;
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

/** Points on the outline of a round-capped, round-joined stroke of this width along a path. */
export function strokeOutline(path: string, width: number): Point[] {
  const half = width / 2;
  const outline: Point[] = [];
  for (const points of flattenPath(path)) {
    for (let index = 0; index + 1 < points.length; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (start === undefined || end === undefined) continue;
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length === 0) continue;
      const normal = at(-(end.y - start.y) / length, (end.x - start.x) / length);
      for (let step = 0; step <= 20; step += 1) {
        const on = at(
          start.x + ((end.x - start.x) * step) / 20,
          start.y + ((end.y - start.y) * step) / 20,
        );
        outline.push(
          at(on.x + normal.x * half, on.y + normal.y * half),
          at(on.x - normal.x * half, on.y - normal.y * half),
        );
      }
    }
    for (const point of points) {
      for (let degrees = 0; degrees < 360; degrees += 5) {
        const radians = (degrees * Math.PI) / 180;
        outline.push(at(point.x + half * Math.cos(radians), point.y + half * Math.sin(radians)));
      }
    }
  }
  return outline;
}

const lowest = (points: ReadonlyArray<Point>, of: (point: Point) => number) =>
  points.reduce((least, point) => Math.min(least, of(point)), Infinity);

/** The smallest distance between two point sets. */
export const closest = (a: ReadonlyArray<Point>, b: ReadonlyArray<Point>) =>
  lowest(a, (point) => lowest(b, (other) => Math.hypot(point.x - other.x, point.y - other.y)));

/**
 * The head's right ear and right horn, found by shape so a redrawn head keeps these checks
 * honest: right of the face's centre, the ear reaches furthest right and the horn highest.
 */
export function rightEarAndHorn(): { readonly ear: Point[]; readonly horn: Point[] } {
  const right = flattenPath(GOAT_BOT_HEAD_PATH).filter((part) => lowest(part, (p) => p.x) > 12);
  const farthest = (part: Point[]) => -lowest(part, (p) => -p.x);
  const ear = right.reduce((widest, part) => (farthest(part) > farthest(widest) ? part : widest));
  const horn = right
    .filter((part) => part !== ear)
    .reduce((highest, part) =>
      lowest(part, (p) => p.y) < lowest(highest, (p) => p.y) ? part : highest,
    );
  return { ear, horn };
}

/** Web's avatar circles and the head each draws (GoatBotAvatar's CIRCLE and HEAD), in px. */
/** The head's share of mobile's avatar circle (apps/mobile GoatBotFace.tsx). */
export const MOBILE_HEAD_RATIO = 0.86;

/** The open space between a "z" mark's top and bottom bars, in art units. */
export function zInnerGap(path: string, width: number): number {
  const ys = flattenPath(path)
    .flat()
    .map((point) => point.y);
  return Math.max(...ys) - Math.min(...ys) - width;
}

/** Web's avatar circles and the head each draws (GoatBotAvatar's CIRCLE and HEAD), in px. */
export const WEB_AVATAR_SIZES = [
  { circle: 20, head: 18 },
  { circle: 28, head: 24 },
  { circle: 48, head: 40 },
  { circle: 72, head: 60 },
] as const;

/** The head's 20-unit art box (2..22) centred in the avatar circle, as px from its corner. */
export const inAvatar = (point: Point, circle: number, head: number): Point =>
  at(
    (circle - head) / 2 + ((point.x - 2) * head) / 20,
    (circle - head) / 2 + ((point.y - 2) * head) / 20,
  );

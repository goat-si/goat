const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;
export const ZOOM_EPSILON = 0.001;

const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );
  if (index < 0) return ZOOM_LEVELS.length - 1;
  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

export const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  let closest = ZOOM_LEVELS[0]!;
  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(closest - value)) closest = level;
  }
  return closest;
};

export const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);
  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }
  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

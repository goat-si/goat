export function initialFeedViewportWidth(
  split: boolean,
  settledPaneWidth: number | null,
  windowWidth: number,
): number {
  return split ? Math.round(settledPaneWidth ?? 0) : windowWidth;
}

import type { PullRequestSurface, RightPanelSurface } from "./rightPanelStore";

/** A pending link belongs to the click that made it, not to a reload or a reopen. */
export const withoutReveal = (surface: RightPanelSurface): RightPanelSurface => {
  if (surface.kind !== "pull-request" || surface.revealUrl === undefined) return surface;
  const { revealUrl: _pending, ...rest } = surface;
  return rest;
};

/** Reopening a pull request with a link updates its surface; a later link replaces one not shown. */
export function withPullRequestLink(
  surfaces: ReadonlyArray<RightPanelSurface>,
  surface: PullRequestSurface,
  revealUrl: string | undefined,
): RightPanelSurface[] {
  return surfaces.map((entry) => {
    if (entry.id !== surface.id || entry.kind !== "pull-request") return entry;
    const { revealUrl: _previous, ...rest } = entry;
    return { ...rest, ...surface, ...(revealUrl ? { revealUrl } : {}) };
  });
}

/** The surfaces with this link settled, or null when the surface now holds another link. */
export function settledPullRequestReveal(
  surfaces: ReadonlyArray<RightPanelSurface>,
  surfaceId: string,
  revealUrl: string,
): RightPanelSurface[] | null {
  const existing = surfaces.find((surface) => surface.id === surfaceId);
  if (existing?.kind !== "pull-request" || existing.revealUrl !== revealUrl) return null;
  return surfaces.map((surface) => (surface.id === surfaceId ? withoutReveal(surface) : surface));
}

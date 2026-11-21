import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("allows the sidebar to narrow to 168px when the brand header fits", () => {
    expect(resolveThreadSidebarMinimumWidth(0)).toBe(168);
    expect(resolveThreadSidebarMinimumWidth(150.2)).toBe(168);
  });

  it("keeps the brand header from clipping when it is wider than the minimum", () => {
    expect(resolveThreadSidebarMinimumWidth(190.4)).toBe(191);
  });

  it("keeps a persisted width that the old 208px minimum used to widen", () => {
    expect(resolveInitialThreadSidebarWidth(180)).toBe(180);
    expect(clampThreadSidebarWidth(180, resolveThreadSidebarMinimumWidth(0), 900)).toBe(180);
  });

  it("raises a persisted width below the new minimum to the minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120)).toBe(168);
    expect(clampThreadSidebarWidth(120, resolveThreadSidebarMinimumWidth(0), 900)).toBe(168);
  });

  it("leaves persisted widths above the minimum and the 256px default unchanged", () => {
    expect(resolveInitialThreadSidebarWidth(320)).toBe(320);
    expect(resolveInitialThreadSidebarWidth(null)).toBe(256);
  });

  it("clamps only the rendered width and restores the preference after a resize", () => {
    const preferred = resolveInitialThreadSidebarWidth(320);
    const minimum = resolveThreadSidebarMinimumWidth(0);
    const render = (viewport: number, rail: number) =>
      clampThreadSidebarWidth(
        preferred,
        minimum,
        resolveThreadSidebarMaximumWidth(viewport - rail, minimum),
      );
    expect(render(700, 0)).toBe(168);
    expect(render(1600, 0)).toBe(320);
    expect(render(900, 56)).toBe(204);
    expect(render(1600, 56)).toBe(320);
  });

  it("never lets the maximum fall below the minimum in a narrow window", () => {
    expect(resolveThreadSidebarMaximumWidth(700)).toBe(168);
    expect(resolveInitialThreadSidebarWidth(320)).toBe(320);
  });
});

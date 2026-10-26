import { describe, expect, it } from "vite-plus/test";

import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
} from "./threadSidebarWidth";

const WIDE_VIEWPORT = 1600;

describe("thread sidebar width", () => {
  it("allows the sidebar to narrow to 168px when the brand header fits", () => {
    expect(resolveThreadSidebarMinimumWidth(0)).toBe(168);
    expect(resolveThreadSidebarMinimumWidth(150.2)).toBe(168);
  });

  it("keeps the brand header from clipping when it is wider than the minimum", () => {
    expect(resolveThreadSidebarMinimumWidth(190.4)).toBe(191);
  });

  it("keeps a persisted width that the old 208px minimum used to widen", () => {
    expect(resolveInitialThreadSidebarWidth(180, WIDE_VIEWPORT)).toBe(180);
    expect(clampThreadSidebarWidth(180, resolveThreadSidebarMinimumWidth(0), 900)).toBe(180);
  });

  it("raises a persisted width below the new minimum to the minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, WIDE_VIEWPORT)).toBe(168);
    expect(clampThreadSidebarWidth(120, resolveThreadSidebarMinimumWidth(0), 900)).toBe(168);
  });

  it("leaves persisted widths above the minimum and the 256px default unchanged", () => {
    expect(resolveInitialThreadSidebarWidth(320, WIDE_VIEWPORT)).toBe(320);
    expect(resolveInitialThreadSidebarWidth(null, WIDE_VIEWPORT)).toBe(256);
  });

  it("never lets the maximum fall below the minimum in a narrow window", () => {
    expect(resolveThreadSidebarMaximumWidth(700)).toBe(168);
    expect(resolveInitialThreadSidebarWidth(320, 700)).toBe(168);
  });
});

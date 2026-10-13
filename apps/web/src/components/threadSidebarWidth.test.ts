import { describe, expect, it } from "vite-plus/test";
import { clampThreadSidebarWidth, resolveThreadSidebarMaximumWidth } from "./threadSidebarWidth";

describe("resolveThreadSidebarMaximumWidth", () => {
  it("never drops below the minimum on a narrow viewport", () => {
    expect(resolveThreadSidebarMaximumWidth(800)).toBe(208);
    expect(resolveThreadSidebarMaximumWidth(1200)).toBe(560);
  });
});

describe("clampThreadSidebarWidth", () => {
  it("widens a stored width below the minimum", () => {
    expect(clampThreadSidebarWidth(180, 208, 560)).toBe(208);
  });

  it("keeps widths inside the range and caps wide ones", () => {
    expect(clampThreadSidebarWidth(300, 208, 560)).toBe(300);
    expect(clampThreadSidebarWidth(900, 208, 560)).toBe(560);
  });
});

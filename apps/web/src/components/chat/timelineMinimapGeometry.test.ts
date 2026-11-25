import { describe, expect, it } from "vite-plus/test";
import {
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
} from "./timelineMinimapGeometry";

describe("resolveTimelineMinimapHitStripWidth", () => {
  it.each([
    { gutter: 256, width: 40 },
    { gutter: 48, width: 36 },
    { gutter: 32, width: 20 },
    { gutter: 24, width: 12 },
    { gutter: 12, width: 0 },
    { gutter: 6, width: 0 },
    { gutter: 0, width: 0 },
    { gutter: -4, width: 0 },
  ])("keeps the minimap inside a $gutter px gutter", ({ gutter, width }) => {
    expect(resolveTimelineMinimapHitStripWidth(gutter)).toBe(width);
  });

  it("shows the persistent gutter once the measured side gutter reaches 48px", () => {
    expect(resolveTimelineMinimapHasPersistentGutter(47)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(48)).toBe(true);
  });
});

import { expect, it } from "vite-plus/test";
import { isTimelineMinimapRowVisible } from "./timelineMinimapGeometry";

it("keeps a turn selected while only its reply is visible", () => {
  expect(isTimelineMinimapRowVisible(10, 500, 200, 210)).toBe(true);
  expect(isTimelineMinimapRowVisible(500, undefined, 600, 610)).toBe(true);
  expect(isTimelineMinimapRowVisible(500, undefined, 200, 210)).toBe(false);
  expect(isTimelineMinimapRowVisible(10, 500, 500, 510)).toBe(false);
  expect(isTimelineMinimapRowVisible(10, 500, null, null)).toBe(false);
});

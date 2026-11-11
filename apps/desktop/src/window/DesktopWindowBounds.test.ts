import { assert, describe, it } from "@effect/vitest";

import { fitsWithinDisplays } from "./DesktopWindowBounds.ts";

describe("fitsWithinDisplays", () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1280 }];

  it("accepts a window saved 1px past a display edge on any side", () => {
    for (const bounds of [
      { x: 1, y: 0, width: 1920, height: 1280 },
      { x: -1, y: 0, width: 1920, height: 1280 },
      { x: 0, y: -1, width: 1920, height: 1280 },
      { x: 0, y: 1, width: 1920, height: 1280 },
    ]) {
      assert.isTrue(fitsWithinDisplays(bounds, displays), JSON.stringify(bounds));
    }
  });

  it("rejects a window further out than 1px past a display edge", () => {
    for (const bounds of [
      { x: 2, y: 0, width: 1920, height: 1280 },
      { x: -2, y: 0, width: 1920, height: 1280 },
      { x: 0, y: -2, width: 1920, height: 1280 },
      { x: 0, y: 2, width: 1920, height: 1280 },
    ]) {
      assert.isFalse(fitsWithinDisplays(bounds, displays), JSON.stringify(bounds));
    }
  });
});

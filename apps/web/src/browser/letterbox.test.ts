import { describe, expect, it } from "vite-plus/test";

import { boxToViewport, viewportToBox } from "./letterbox";

const page = { width: 1280, height: 800 };

describe("letterboxed page coordinates", () => {
  it("maps a click in a square box onto the page under it, past the bars", () => {
    // A 1280x800 frame in a 400x400 box is 400x250 with 75px bars above and below.
    const box = { width: 400, height: 400 };
    expect(boxToViewport({ x: 200, y: 200 }, box, page, page)).toEqual({
      x: 640,
      y: 400,
      scale: 3.2,
    });
    expect(boxToViewport({ x: 0, y: 75 }, box, page, page)).toMatchObject({ x: 0, y: 0 });
    expect(boxToViewport({ x: 0, y: 10 }, box, page, page)?.y).toBeLessThan(0);
  });

  it("keeps a point on the same page spot when the window resizes the box", () => {
    // The page keeps its viewport; only the box around it grows or shrinks.
    for (const box of [
      { width: 240, height: 150 },
      { width: 640, height: 400 },
      { width: 900, height: 420 },
    ]) {
      const spot = viewportToBox({ x: 1000, y: 300 }, box, page, page);
      const back = boxToViewport(spot, box, page, page);
      expect(back?.x).toBeCloseTo(1000);
      expect(back?.y).toBeCloseTo(300);
    }
  });

  it("scales by the page viewport when frames arrive smaller than it", () => {
    // Thumbnails stream a 480px frame of the same page; clicks still land in page pixels.
    const frame = { width: 480, height: 300 };
    expect(boxToViewport({ x: 120, y: 75 }, { width: 240, height: 150 }, frame, page)).toEqual({
      x: 640,
      y: 400,
      scale: 1280 / 240,
    });
  });

  it("finds no point when nothing is painted yet", () => {
    expect(boxToViewport({ x: 1, y: 1 }, { width: 0, height: 0 }, page, page)).toBeNull();
  });
});

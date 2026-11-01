import { describe, expect, it } from "vite-plus/test";
import { clampScale, layoutPages, pageAtOffset, visiblePages } from "./pdfLayout";

describe("PDF page layout", () => {
  const sizes = [
    { width: 600, height: 800 },
    { width: 1000, height: 500 },
    { width: 400, height: 1000 },
  ];
  it("fits every mixed-size page to width and uses its own height for jumping", () => {
    const pages = layoutPages(sizes, { width: 632, height: 432 }, "fit-width");
    expect(pages.map((page) => page.width)).toEqual([600, 600, 600]);
    expect(pages.map((page) => page.height)).toEqual([800, 300, 1500]);
    expect(pages.map((page) => page.top)).toEqual([16, 832, 1148]);
    expect(pageAtOffset(pages, 832)).toBe(1);
  });
  it("fits a whole page independently, clamps zoom and accepts resize", () => {
    const pages = layoutPages(sizes, { width: 632, height: 432 }, "fit-page");
    expect(pages.map((page) => page.height)).toEqual([400, 300, 400]);
    expect(clampScale(50)).toBe(5);
    expect(clampScale(-1)).toBe(0.1);
    expect(clampScale(NaN)).toBe(1);
    expect(layoutPages(sizes, { width: 332, height: 232 }, "fit-width")[0]?.width).toBe(300);
  });
  it("keeps a long document's render set bounded to the visible viewport", () => {
    const pages = layoutPages(
      Array.from({ length: 10_000 }, () => sizes[0]!),
      { width: 632, height: 432 },
      1,
    );
    expect(visiblePages(pages, pages[4999]!.top, 432).map((page) => page.index)).toEqual([4999]);
    expect(visiblePages(pages, 790, 100).map((page) => page.index)).toEqual([0, 1]);
    expect(visiblePages([], 0, 100)).toEqual([]);
  });
});

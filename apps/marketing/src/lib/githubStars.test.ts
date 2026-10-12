import { describe, expect, it } from "vite-plus/test";

import { formatStarCount } from "./githubStars";

describe("formatStarCount", () => {
  it("shows small counts exactly and rounds larger ones down", () => {
    expect(formatStarCount(0)).toBe("0");
    expect(formatStarCount(999)).toBe("999");
    expect(formatStarCount(1000)).toBe("1k+");
    expect(formatStarCount(1250)).toBe("1.2k+");
    expect(formatStarCount(9999)).toBe("9.9k+");
    expect(formatStarCount(24_310)).toBe("24k+");
  });
});

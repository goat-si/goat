import { describe, expect, it } from "vite-plus/test";

import { GOAT_BOT_LIST_PADDING, goatBotFooterInView } from "./goatBotListEnd";

// A 600 pt viewport over 2000 pt of content whose last 40 pt (above the padding) is the progress line.
const base = { viewportHeight: 600, contentHeight: 2000, footerHeight: 40 };
const atEnd = base.contentHeight - base.viewportHeight;

describe("goatBotFooterInView", () => {
  it("counts the progress line in view when the list rests at its end", () => {
    expect(goatBotFooterInView({ ...base, offsetY: atEnd })).toBe(true);
  });

  it("does not count a line that only the bottom padding keeps near the viewport edge", () => {
    // Only 4 pt of the line shows above the viewport's bottom edge.
    const offsetY = atEnd - GOAT_BOT_LIST_PADDING - 36;
    expect(goatBotFooterInView({ ...base, offsetY })).toBe(false);
  });

  it("counts the line once at least half of it shows", () => {
    expect(goatBotFooterInView({ ...base, offsetY: atEnd - GOAT_BOT_LIST_PADDING - 20 })).toBe(
      true,
    );
    expect(goatBotFooterInView({ ...base, offsetY: atEnd - GOAT_BOT_LIST_PADDING - 21 })).toBe(
      false,
    );
  });

  it("drops the line out of view when new content pushes it below a resting scroll position", () => {
    expect(goatBotFooterInView({ ...base, offsetY: atEnd, contentHeight: 2300 })).toBe(false);
  });

  it("is out of view after scrolling up a screen and before the line or list is measured", () => {
    expect(goatBotFooterInView({ ...base, offsetY: atEnd - 600 })).toBe(false);
    expect(goatBotFooterInView({ ...base, offsetY: atEnd, footerHeight: 0 })).toBe(false);
    expect(goatBotFooterInView({ ...base, offsetY: atEnd, viewportHeight: 0 })).toBe(false);
  });
});

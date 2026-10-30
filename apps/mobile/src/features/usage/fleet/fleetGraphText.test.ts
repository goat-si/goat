import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_BASE_FONT_SIZE } from "../../../lib/appearancePreferences";
import { showsFleetGraph } from "./fleetGraphText";

describe("showsFleetGraph", () => {
  it("shows the graph at default text and at the system sizes just above it", () => {
    for (const fontScale of [0.85, 1, 1.15, 1.3]) {
      expect(showsFleetGraph({ baseFontSize: DEFAULT_BASE_FONT_SIZE, fontScale })).toBe(true);
    }
  });

  it("hides it at accessibility system sizes, where names cannot be readable in the graph", () => {
    expect(showsFleetGraph({ baseFontSize: DEFAULT_BASE_FONT_SIZE, fontScale: 1.5 })).toBe(false);
    expect(showsFleetGraph({ baseFontSize: DEFAULT_BASE_FONT_SIZE, fontScale: 3 })).toBe(false);
  });

  it("hides it when GOAT's own text size makes a label line taller than its box", () => {
    // At GOAT's largest text size (22 pt) a label line is 22 pt: it fits at system scale 1 and
    // no longer fits once the system scales text up.
    expect(showsFleetGraph({ baseFontSize: 22, fontScale: 1 })).toBe(true);
    expect(showsFleetGraph({ baseFontSize: 22, fontScale: 1.1 })).toBe(false);
    expect(showsFleetGraph({ baseFontSize: 19, fontScale: 1.2 })).toBe(false);
    expect(showsFleetGraph({ baseFontSize: 16, fontScale: 1.2 })).toBe(true);
  });
});

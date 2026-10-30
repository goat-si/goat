import { COMPACT_GRAPH_NODES } from "@goat/client-runtime/state/fleet-layout";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_FONT_SIZE,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../lib/appearancePreferences";
import { fleetGraphLabelStyle, showsFleetGraph } from "./fleetGraphText";

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
    expect(showsFleetGraph({ baseFontSize: 22, fontScale: 1 })).toBe(true);
    expect(showsFleetGraph({ baseFontSize: 22, fontScale: 1.1 })).toBe(false);
    expect(showsFleetGraph({ baseFontSize: 19, fontScale: 1.2 })).toBe(false);
  });

  it("never draws a label line taller than its box, whatever both text settings are", () => {
    // Regression: a system scale above the cap (1.3) once grew Android's line past the box.
    for (let base = MIN_BASE_FONT_SIZE; base <= MAX_BASE_FONT_SIZE; base++) {
      for (const fontScale of [0.8, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.49]) {
        if (!showsFleetGraph({ baseFontSize: base, fontScale })) continue;
        expect(
          fleetGraphLabelStyle({ baseFontSize: base, fontScale }).lineHeight,
        ).toBeLessThanOrEqual(COMPACT_GRAPH_NODES.labelHeight);
      }
    }
    expect(fleetGraphLabelStyle({ baseFontSize: 18, fontScale: 1.3 })).toEqual({
      fontSize: 16.2,
      lineHeight: 21.6,
    });
  });
});

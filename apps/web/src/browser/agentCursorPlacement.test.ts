import { describe, expect, it } from "vite-plus/test";

import { placeAgentCursor, replaceAgentCursor } from "./agentCursorPlacement";

const viewport = { width: 1280, height: 800 };
/** A canvas shown at 640x400 CSS pixels, before and after its first decoded 1280x800 frame. */
const defaultCanvas = { width: 300, height: 150, clientWidth: 640, clientHeight: 400 };
const paintedCanvas = { width: 1280, height: 800, clientWidth: 640, clientHeight: 400 };
const pointer = { phase: "move" as const, x: 320, y: 200, sequence: 3 };

describe("agent cursor placement", () => {
  it("a pointer that arrived before the first frame moves to its page point once the frame paints", () => {
    const early = placeAgentCursor(pointer, defaultCanvas, viewport);
    // The default 2:1 canvas letterboxes the page into a band 40 px down, so the point sits low.
    expect(early).toMatchObject({ left: 160, top: 120 });
    const kept = { ...early!, cursorPhase: "resting" as const };
    expect(replaceAgentCursor(kept, pointer, paintedCanvas, viewport)).toEqual({
      ...kept,
      left: 160,
      top: 100,
    });
  });

  it("a hidden cursor stays hidden when a frame resizes the canvas", () => {
    expect(replaceAgentCursor(null, pointer, paintedCanvas, viewport)).toBeNull();
  });
});

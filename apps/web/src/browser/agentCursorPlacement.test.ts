import { EnvironmentId } from "@goat/contracts";
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

  it("a drawn cursor follows its page point when its box or the viewport changes", () => {
    const owner = {
      environmentId: EnvironmentId.make("env-1"),
      runId: "run-1",
      turnId: "turn-1",
      targetId: "tab-1",
      generation: 1,
      sequence: 4,
    };
    const owned = { ...pointer, cursor: { identity: owner, phase: "acting" as const } };
    const drawn = {
      ...placeAgentCursor(owned, paintedCanvas, viewport)!,
      cursorPhase: "resting" as const,
    };
    expect(drawn).toMatchObject({ left: 160, top: 100, owner });
    // The panel shrinks to half its size: the cursor stays on the same spot of the page.
    const halfBox = { ...paintedCanvas, clientWidth: 320, clientHeight: 200 };
    expect(replaceAgentCursor(drawn, owned, halfBox, viewport)).toEqual({
      ...drawn,
      left: 80,
      top: 50,
    });
    // The viewport halves while frames keep their size: the mouse keeps its viewport pixels.
    expect(replaceAgentCursor(drawn, owned, paintedCanvas, { width: 640, height: 400 })).toEqual({
      ...drawn,
      left: 320,
      top: 200,
    });
    // A collapsed card has no box to place in; the cursor waits for the next resize.
    const collapsed = { ...paintedCanvas, clientWidth: 0, clientHeight: 0 };
    expect(replaceAgentCursor(drawn, owned, collapsed, viewport)).toBe(drawn);
    // Unchanged geometry keeps the object, so React bails out of the update.
    expect(replaceAgentCursor(drawn, owned, paintedCanvas, viewport)).toBe(drawn);
  });
});

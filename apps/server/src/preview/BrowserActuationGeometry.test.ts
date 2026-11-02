import { describe, expect, it } from "vite-plus/test";

import {
  classifyOcclusionHitTest,
  evaluateTogglePostcondition,
  selectClickPoint,
} from "./BrowserActuationGeometry.ts";

const viewport = { width: 800, height: 600 };
const rect = (left: number, top: number, right: number, bottom: number) => [
  left,
  top,
  right,
  top,
  right,
  bottom,
  left,
  bottom,
];
const frame = (x: number, y: number, width: number, height: number, scrollX = 0, scrollY = 0) => ({
  bounds: { x, y, width, height },
  scrollX,
  scrollY,
});

describe("click point selection", () => {
  it("clicks the quad with the most visible area, not the largest quad", () => {
    const mostlyOffscreen = rect(700, 0, 1700, 100);
    const fullyVisible = rect(0, 200, 200, 300);
    expect(selectClickPoint({ quads: [mostlyOffscreen, fullyVisible], viewport })).toEqual({
      ok: true,
      point: { x: 100, y: 250 },
    });
    expect(
      selectClickPoint({ quads: [rect(0, 0, 10, 10), rect(20, 0, 30, 10)], viewport }),
    ).toEqual({
      ok: true,
      point: { x: 5, y: 5 },
    });
  });

  it("keeps a partly visible target's point in the middle of its visible part", () => {
    expect(selectClickPoint({ quads: [rect(-100, 0, 100, 100)], viewport })).toEqual({
      ok: true,
      point: { x: 50, y: 50 },
    });
  });

  it("maps a nested frame's quad to the top viewport by adding iframe offsets and subtracting scroll", () => {
    const outer = frame(100, 50, 400, 300, 0, 20);
    const inner = frame(10, 200, 100, 100, 0, 150);
    expect(
      selectClickPoint({ quads: [rect(10, 10, 30, 30)], viewport, frames: [outer, inner] }),
    ).toEqual({ ok: true, point: { x: 130, y: 100 } });
  });

  it("clips the target by its frame's visible rect, not just the viewport", () => {
    expect(
      selectClickPoint({
        quads: [rect(150, 0, 250, 100)],
        viewport,
        frames: [frame(0, 0, 200, 200)],
      }),
    ).toEqual({ ok: true, point: { x: 175, y: 50 } });
  });

  it("keeps a rotated quad's point inside the part its frame shows", () => {
    const diamond = [60, 50, 100, 10, 140, 50, 100, 90];
    const result = selectClickPoint({
      quads: [diamond],
      viewport,
      frames: [frame(0, 0, 100, 100)],
    });
    expect(result).toEqual({ ok: true, point: { x: expect.closeTo(260 / 3), y: 50 } });
  });

  it("refuses with nothing sent when a containing frame's transform is unproven", () => {
    const oopif = { ...frame(0, 0, 400, 400), unproven: true };
    expect(
      selectClickPoint({
        quads: [rect(0, 0, 50, 50)],
        viewport,
        frames: [frame(0, 0, 500, 500), oopif],
      }),
    ).toEqual({ ok: false, reason: "oopif_transform_unproven", nothingSent: true });
  });

  it("refuses a target with no visible area instead of clicking outside it", () => {
    const refused = { ok: false, reason: "no_visible_area", nothingSent: true };
    expect(selectClickPoint({ quads: [rect(900, 0, 1000, 100)], viewport })).toEqual(refused);
    expect(selectClickPoint({ quads: [rect(-100, 0, 0, 100)], viewport })).toEqual(refused);
    // Its bounding box overlaps the viewport; the diamond itself does not.
    const diamond = [-25, -10, -10, -25, 5, -10, -10, 5];
    expect(selectClickPoint({ quads: [diamond], viewport })).toEqual(refused);
    expect(
      selectClickPoint({
        quads: [rect(900, 0, 1000, 100)],
        box: { x: 0, y: 0, width: 50, height: 50 },
        viewport,
      }),
    ).toEqual(refused);
  });

  it("needs at least one CSS pixel of visible area", () => {
    expect(selectClickPoint({ quads: [rect(-0.5, 0, 0.5, 1)], viewport })).toEqual({
      ok: false,
      reason: "no_visible_area",
      nothingSent: true,
    });
    expect(selectClickPoint({ quads: [rect(-1, 0, 1, 1)], viewport })).toEqual({
      ok: true,
      point: { x: 0.5, y: 0.5 },
    });
  });

  it("skips malformed quads and uses the box only when no quad is usable", () => {
    const quads = [
      [Number.NaN, 0, 10, 0, 10, 10, 0, 10],
      [0, 0, 10, 0, 10, 10],
      [0, 0, 10, 10, 10, 0, 0, 10],
    ];
    const box = { x: 10, y: 10, width: 20, height: 20 };
    expect(selectClickPoint({ quads, box, viewport })).toEqual({
      ok: true,
      point: { x: 20, y: 20 },
    });
    expect(selectClickPoint({ quads, viewport })).toEqual({
      ok: false,
      reason: "invalid_geometry",
      nothingSent: true,
    });
  });

  it.each([
    ["an empty viewport", { width: 0, height: 600 }, []],
    ["a frame without size", viewport, [frame(0, 0, Number.NaN, 100)]],
    ["a frame with unknown scroll", viewport, [frame(0, 0, 100, 100, Number.POSITIVE_INFINITY)]],
  ])("refuses %s as invalid geometry", (_name, size, frames) => {
    expect(selectClickPoint({ quads: [rect(0, 0, 10, 10)], viewport: size, frames })).toEqual({
      ok: false,
      reason: "invalid_geometry",
      nothingSent: true,
    });
  });
});

describe("occlusion hit test", () => {
  const refused = {
    ok: false,
    code: "unsupported",
    message: expect.any(String),
    detail: { kind: "occluded_refused" },
    nothingSent: true,
  };

  it("lets the click through when the target, a descendant, or its label or control is hit", () => {
    expect(
      classifyOcclusionHitTest({ backendNodeId: 7, hitMatchesTargetOrDescendant: true }),
    ).toEqual({
      ok: true,
    });
    expect(
      classifyOcclusionHitTest({
        backendNodeId: 7,
        hitMatchesTargetOrDescendant: false,
        hitIsAssociatedLabelOrControl: true,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses with nothing sent when something else covers the point", () => {
    expect(
      classifyOcclusionHitTest({ backendNodeId: 7, hitMatchesTargetOrDescendant: false }),
    ).toEqual(refused);
  });

  it.each(["Could not find node with given id", ""])(
    "regression: refuses when the hit test failed (%j), where browser-use assumed no occlusion",
    (hitTestError) => {
      const verdict = classifyOcclusionHitTest({
        backendNodeId: 7,
        hitMatchesTargetOrDescendant: true,
        hitTestError,
      });
      expect(verdict).toEqual(refused);
      expect(JSON.stringify(verdict)).not.toContain("Could not find node");
    },
  );
});

describe("toggle postcondition", () => {
  it.each([
    [false, true, "toggle_verified"],
    [true, false, "toggle_verified"],
    [false, false, "toggle_unverified"],
    [true, true, "toggle_unverified"],
    [undefined, true, "toggle_unverified"],
    [false, undefined, "toggle_unverified"],
  ] as const)("reads %s then %s as %s", (before, after, verdict) => {
    expect(evaluateTogglePostcondition(before, after)).toBe(verdict);
  });
});

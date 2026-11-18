import { assert, describe, it } from "@effect/vitest";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "./mainWindowPlacement.ts";

describe("main window placement", () => {
  it("restores bounds when the window fits within a display or spans contiguous displays", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const spanningHorizontalBounds = { x: 1400, y: 80, width: 1100, height: 780 };
    const spanningVerticalBounds = { x: 120, y: 760, width: 1100, height: 780 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    const verticalDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 1080, width: 1920, height: 1080 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(spanningHorizontalBounds, displays),
      spanningHorizontalBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(spanningVerticalBounds, verticalDisplays),
      spanningVerticalBounds,
    );
  });

  it("clamps bounds across a gap or dead space between displays while preserving size", () => {
    const spanningBounds = { x: 1400, y: 80, width: 1100, height: 780 };
    const gappedDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 2120, y: 0, width: 1920, height: 1080 },
    ];
    assert.deepEqual(DesktopWindow.resolveInitialMainWindowBounds(spanningBounds, gappedDisplays), {
      x: 820,
      y: 80,
      width: 1100,
      height: 780,
    });

    const deadSpaceBounds = { x: 1400, y: 300, width: 1320, height: 900 };
    const staggeredDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(deadSpaceBounds, staggeredDisplays),
      { x: 1920, y: 300, width: 1320, height: 900 },
    );
  });

  it("preserves and clamps saved size when an external display is disconnected", () => {
    const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1080 };

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds({ x: 2040, y: 80, width: 1320, height: 880 }, [
        primaryDisplay,
      ]),
      { x: 600, y: 80, width: 1320, height: 880 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds({ x: 2040, y: 80, width: 2200, height: 1200 }, [
        primaryDisplay,
      ]),
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(
        { x: 2040, y: 80, width: 1320, height: 880 },
        [],
      ),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });
});

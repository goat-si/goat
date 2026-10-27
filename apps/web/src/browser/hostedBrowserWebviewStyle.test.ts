import { describe, expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("keeps a capture-active hidden guest painting in the viewport without showing it through a translucent window", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      keepPaintableWhenInactive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toMatchObject({ left: 0, top: 0, visibility: "visible", pointerEvents: "none" });
    expect(style.opacity).toBeGreaterThan(0);
    expect(style.opacity).toBeLessThan(0.01);
  });

  it("shows a presented guest at full opacity", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: true,
      renderingActive: true,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style.opacity).toBeUndefined();
  });
});

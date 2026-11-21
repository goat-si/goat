import { describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { BrowserWindow } from "electron";
import { syncWindowAppearance } from "./DesktopWindowAppearance.ts";

describe("window appearance", () => {
  it.effect("updates a framed window background without setting an unavailable overlay", () =>
    Effect.gen(function* () {
      const setBackgroundColor = vi.fn();
      const setTitleBarOverlay = vi.fn(() => {
        throw new Error("overlay unavailable");
      });
      const window = {
        isDestroyed: () => false,
        setBackgroundColor,
        setTitleBarOverlay,
      } as unknown as BrowserWindow;
      yield* syncWindowAppearance(window, true, "win32", false, false);
      expect(setBackgroundColor).toHaveBeenCalledWith("#171717");
      expect(setTitleBarOverlay).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { platform: "win32" as const, overlay: true },
    { platform: "linux" as const, overlay: true },
    { platform: "darwin" as const, overlay: false },
  ])("updates theme appearance on $platform", ({ platform, overlay }) =>
    Effect.gen(function* () {
      const setBackgroundColor = vi.fn();
      const setTitleBarOverlay = vi.fn();
      const window = {
        isDestroyed: () => false,
        setBackgroundColor,
        setTitleBarOverlay,
      } as unknown as BrowserWindow;
      yield* syncWindowAppearance(window, true, platform, false, overlay);
      expect(setBackgroundColor).toHaveBeenCalledWith("#171717");
      expect(setTitleBarOverlay).toHaveBeenCalledTimes(overlay ? 1 : 0);
    }),
  );
});

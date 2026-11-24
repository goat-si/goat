import { expect, it, vi } from "vite-plus/test";
import { measuredResize } from "./agentTabState.ts";

it("rejects an undrawn fixed resize and its retry", async () => {
  vi.useFakeTimers();
  try {
    const tab = {
      desktop: {},
      page: { viewportSize: () => null },
      setting: { _tag: "fill" } as import("@goat/contracts").PreviewViewportSetting,
      desktopViewport: { width: 500, height: 500 },
      desktopViewportChanges: 0,
      desktopResize: Promise.withResolvers<void>(),
      desktopResizeUndrawn: false,
    };
    const size = { _tag: "freeform", width: 900, height: 700 } as const;
    const attempt = () =>
      measuredResize(
        tab,
        tab.desktopViewport,
        async () => {
          tab.setting = size;
        },
        { measure: async () => tab.desktopViewport, deadlineMs: Infinity },
      );
    const first = attempt();
    const firstResult = expect(first).rejects.toThrow("did not draw");
    await vi.advanceTimersByTimeAsync(1000);
    await firstResult;
    const retry = attempt();
    const retryResult = expect(retry).rejects.toThrow("did not draw");
    await vi.advanceTimersByTimeAsync(1000);
    await retryResult;
  } finally {
    vi.useRealTimers();
  }
});

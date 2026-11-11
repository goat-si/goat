import { describe, expect, it, vi } from "vite-plus/test";

import { makeFontDefaultFamiliesCache } from "./fontDefaultFamiliesCache";

const fakeFonts = (status: "loading" | "loaded") =>
  Object.assign(new EventTarget(), { status }) as EventTarget & { status: "loading" | "loaded" };

describe("makeFontDefaultFamiliesCache", () => {
  it("probes once while fonts stay loaded, and again after new fonts load or the window refocuses", () => {
    const fonts = fakeFonts("loaded");
    const windowTarget = new EventTarget();
    const probe = vi.fn(() => ({ sans: "Inter", code: "Menlo" }));
    const cache = makeFontDefaultFamiliesCache(fonts, windowTarget);

    cache.get(probe);
    cache.get(probe);
    expect(probe).toHaveBeenCalledTimes(1);

    fonts.dispatchEvent(new Event("loadingdone"));
    cache.get(probe);
    expect(probe).toHaveBeenCalledTimes(2);

    windowTarget.dispatchEvent(new Event("focus"));
    cache.get(probe);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("does not keep a result probed while fonts are still loading", () => {
    const fonts = fakeFonts("loading");
    const probe = vi.fn(() => ({ sans: "System default", code: "System monospace" }));
    const cache = makeFontDefaultFamiliesCache(fonts, new EventTarget());
    cache.get(probe);
    cache.get(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

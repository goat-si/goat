import { describe, expect, it } from "vite-plus/test";

import { isProjectFaviconPath } from "./projectFavicon.ts";

describe("project favicon", () => {
  it("accepts favicon images that every client can render", () => {
    expect(isProjectFaviconPath("/repo/icon.PNG")).toBe(true);
    expect(isProjectFaviconPath("/repo/AppIcon.icns")).toBe(true);
    // HEIC previews in the Files tab, but Chromium cannot draw it as a favicon.
    expect(isProjectFaviconPath("/repo/icon.heic")).toBe(false);
    expect(isProjectFaviconPath("/repo/icon.HEIF")).toBe(false);
  });
});

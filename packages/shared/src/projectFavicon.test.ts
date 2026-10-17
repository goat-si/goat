import { describe, expect, it } from "vite-plus/test";

import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
  isProjectFaviconPath,
  PROJECT_FAVICON_FALLBACK_MARKER,
} from "./projectFavicon.ts";

describe("project favicon", () => {
  it("uses the project and versioned filename as the cache identity", () => {
    const firstUrl = "https://environment.example/api/assets/first-signed-token/v1-20-favicon.svg";
    const refreshedUrl =
      "https://environment.example/api/assets/refreshed-signed-token/v1-20-favicon.svg";

    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).toBe(
      getProjectFaviconCacheKey("environment-1", "/workspace", refreshedUrl),
    );
    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).not.toBe(
      getProjectFaviconCacheKey(
        "environment-1",
        "/workspace",
        "https://environment.example/api/assets/refreshed-signed-token/v2-20-favicon.svg",
      ),
    );
    expect(getProjectFaviconCacheKey("environment-1", "/workspace", firstUrl)).not.toBe(
      getProjectFaviconCacheKey("environment-2", "/workspace", firstUrl),
    );
  });

  it("accepts favicon images that every client can render", () => {
    expect(isProjectFaviconPath("/repo/icon.PNG")).toBe(true);
    expect(isProjectFaviconPath("/repo/AppIcon.icns")).toBe(true);
    // HEIC previews in the Files tab, but Chromium cannot draw it as a favicon.
    expect(isProjectFaviconPath("/repo/icon.heic")).toBe(false);
    expect(isProjectFaviconPath("/repo/icon.HEIF")).toBe(false);
  });

  it("identifies fallback asset URLs by their dedicated filename", () => {
    expect(
      isProjectFaviconFallbackUrl(
        `https://environment.example/api/assets/signed-token/${PROJECT_FAVICON_FALLBACK_MARKER}`,
      ),
    ).toBe(true);
    expect(
      isProjectFaviconFallbackUrl(`/api/assets/signed-token/${PROJECT_FAVICON_FALLBACK_MARKER}`),
    ).toBe(true);
  });

  it("does not mistake real favicons or query parameters for fallbacks", () => {
    expect(
      isProjectFaviconFallbackUrl("https://environment.example/api/assets/token/favicon.svg"),
    ).toBe(false);
    expect(
      isProjectFaviconFallbackUrl(
        `https://environment.example/api/assets/token/favicon.svg?name=${PROJECT_FAVICON_FALLBACK_MARKER}`,
      ),
    ).toBe(false);
    expect(isProjectFaviconFallbackUrl(null)).toBe(false);
  });
});

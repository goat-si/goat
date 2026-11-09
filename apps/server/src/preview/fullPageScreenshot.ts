import type { PreviewAutomationSnapshot } from "@goat/contracts";
import type { CDPSession } from "playwright-core";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { documentPlacement } from "./ServerBrowserScreen.ts";

const MAX_FULL_PAGE_WIDTH = 3840;
const MAX_FULL_PAGE_HEIGHT = 16_384;
const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FULL_PAGE_TOO_LARGE =
  "The full-page screenshot exceeds the 3840 × 16384 pixel or 8 MiB limit, even at reduced scale. Use a viewport snapshot instead.";
// A second capture would fail the same way; this one already tried every scale.

// Bounds, PNG checks, and scale retries adapted from Emanuele-web04/synara @ 566efb1b1.
// Copyright (c) 2026 Emanuele Di Pietro. MIT license; see the repository LICENSE.
/** Captures at CSS resolution or lower without changing viewport, scroll, or emulation. */
export const captureFullPage = async (
  cdp: CDPSession,
): Promise<NonNullable<PreviewAutomationSnapshot["screenshot"]>> => {
  const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
  if (!Number.isFinite(cssContentSize.width) || !Number.isFinite(cssContentSize.height)) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "The browser did not report valid document dimensions for a full-page screenshot.",
    );
  }
  const width = Math.min(MAX_FULL_PAGE_WIDTH, Math.max(1, Math.ceil(cssContentSize.width)));
  const height = Math.min(MAX_FULL_PAGE_HEIGHT, Math.max(1, Math.ceil(cssContentSize.height)));
  const clipped = width < cssContentSize.width || height < cssContentSize.height;
  // CSS clips and image pixels differ across native and emulated Retina tabs. Bound
  // the actual PNG to the CSS clip so Retina captures cannot exceed CSS resolution.
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    const byteLength = Buffer.byteLength(data, "base64");
    if (byteLength > MAX_FULL_PAGE_BYTES) continue;
    const header = Buffer.from(data.slice(0, 32), "base64");
    if (
      header.length < 24 ||
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "The browser returned an invalid full-page PNG. Try another snapshot.",
      );
    }
    const imageWidth = header.readUInt32BE(16);
    const imageHeight = header.readUInt32BE(20);
    if (imageWidth < 1 || imageHeight < 1 || imageWidth > width || imageHeight > height) continue;
    return {
      mimeType: "image/png" as const,
      data,
      width: imageWidth,
      height: imageHeight,
      fullPage: true,
      clipped,
      byteLength,
      ...documentPlacement(width, height, imageWidth),
    };
  }
  throw new ServerBrowserOperationError("PreviewAutomationExecutionError", FULL_PAGE_TOO_LARGE);
};

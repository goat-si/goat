import { computerUseImageInfo, PREVIEW_SESSION_FRAME_LIMITS } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BUSY_CAPTURE,
  SHARED_CAPTURE,
  UNREDIRECTED_CAPTURE,
} from "../linuxHelper/x11WindowCapture.ts";
import { encodeJpeg } from "./jpeg.ts";
import { frameJpeg, frameSize, refusalOutcome } from "./LinuxFrameSource.ts";

/** Busy pixels, which compress worst: a fair test of the byte limit. */
const noise = (width: number, height: number) => {
  const rgb = new Uint8Array(width * height * 3);
  let seed = 7;
  for (let index = 0; index < rgb.length; index++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    rgb[index] = seed & 0xff;
  }
  return rgb;
};

describe("Linux live frames (#1370)", () => {
  it("encodes a JPEG the contract reads back at its size, smaller at lower quality", () => {
    const rgb = noise(37, 21);
    const high = encodeJpeg(rgb, 37, 21, 90);
    const low = encodeJpeg(rgb, 37, 21, 30);
    expect(computerUseImageInfo(Buffer.from(high).toString("base64"))).toEqual({
      mimeType: "image/jpeg",
      width: 37,
      height: 21,
    });
    expect(low.length).toBeLessThan(high.length);
  });

  it("keeps every frame within the frame limits, or sends none", () => {
    const data = frameJpeg(noise(480, 300), 480, 300);
    expect(data).toBeDefined();
    expect(Buffer.from(data ?? "", "base64").length).toBeLessThanOrEqual(
      PREVIEW_SESSION_FRAME_LIMITS.maxBytes,
    );
    // A window is captured no wider than asked, and never scaled up.
    expect(frameSize(480)(1920, 1080)).toEqual({
      width: 480,
      height: 270,
      windowWidth: 1920,
      windowHeight: 1080,
    });
    expect(frameSize(480)(300, 200)).toMatchObject({ width: 300, height: 200 });
  });

  it("tells a viewer why there is no picture, and says nothing for a capture that clears by itself", () => {
    expect(refusalOutcome(BUSY_CAPTURE, true)).toEqual({ skip: true });
    expect(refusalOutcome(SHARED_CAPTURE, false)).toEqual({ unavailable: "captureFailed" });
    expect(refusalOutcome(UNREDIRECTED_CAPTURE, false)).toEqual({ unavailable: "unsupported" });
  });
});

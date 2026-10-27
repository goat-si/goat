import { describe, expect, it } from "vite-plus/test";

import { drawActivityDot, type Bitmap } from "./trayIcons.ts";

const bgra = (bitmap: Bitmap, x: number, y: number) => {
  const offset = (y * bitmap.width + x) * 4;
  return Array.from(bitmap.pixels.subarray(offset, offset + 4));
};

describe("drawActivityDot", () => {
  it("draws a black dot of radius 4 and a clear ring on an 18x18 transparent bitmap", () => {
    const pixels = new Uint8Array(18 * 18 * 4);
    const base: Bitmap = { width: 18, height: 18, pixels };
    const before = Uint8Array.from(pixels);
    const drawn = drawActivityDot(base, [0, 0, 0]);

    expect(drawn).not.toBe(base);
    expect(drawn.pixels).not.toBe(pixels);
    expect(Array.from(pixels)).toEqual(Array.from(before));
    expect(drawn.width).toBe(18);
    expect(drawn.height).toBe(18);
    // Center (13.5, 13.5) sits on pixel (13, 13); the filled edge is 4px away.
    expect(bgra(drawn, 13, 13)).toEqual([0, 0, 0, 255]);
    expect(bgra(drawn, 13, 9)).toEqual([0, 0, 0, 255]);
    expect(bgra(drawn, 13, 8)).toEqual([0, 0, 0, 0]);
    expect(bgra(drawn, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("draws an orange dot of radius 7 and a clear ring on a 36x36 white bitmap", () => {
    const pixels = new Uint8Array(36 * 36 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = 255;
    }
    const base: Bitmap = { width: 36, height: 36, pixels };
    const before = Uint8Array.from(pixels);
    const drawn = drawActivityDot(base, [0x0a, 0x9f, 0xff]);

    expect(Array.from(pixels)).toEqual(Array.from(before));
    expect(drawn.pixels).not.toBe(pixels);
    // Center pixel (28, 28); radius 7 stays filled, and the ring reaches 2px past it.
    expect(bgra(drawn, 28, 28)).toEqual([0x0a, 0x9f, 0xff, 255]);
    expect(bgra(drawn, 28, 21)).toEqual([0x0a, 0x9f, 0xff, 255]);
    expect(bgra(drawn, 28, 20)).toEqual([0, 0, 0, 0]);
    expect(bgra(drawn, 28, 19)).toEqual([0, 0, 0, 0]);
    expect(bgra(drawn, 28, 18)).toEqual([255, 255, 255, 255]);
    expect(bgra(drawn, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});

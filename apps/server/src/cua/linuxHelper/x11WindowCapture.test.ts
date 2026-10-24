import { describe, expect, it } from "vite-plus/test";

import { pngColors } from "./linuxSession.ts";
import { parseSetup, zpixmapToPng } from "./x11WindowCapture.ts";

/** A setup reply: one pixmap format (depth 24 at 32 bpp), one screen, one TrueColor visual. */
function setupReply(options: { readonly lsb: boolean }) {
  const vendor = "GOAT";
  const bytes = new Uint8Array(40 + 4 + 8 + 40 + 8 + 24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(6, (bytes.length - 8) / 4, true);
  view.setUint32(12, 0x0400000, true);
  view.setUint16(24, vendor.length, true);
  bytes[28] = 1;
  bytes[29] = 1;
  bytes[30] = options.lsb ? 0 : 1;
  bytes.set(new TextEncoder().encode(vendor), 40);
  bytes.set([24, 32, 32], 44);
  const screen = 52;
  view.setUint32(screen, 0x2b, true);
  bytes[screen + 39] = 1;
  bytes[screen + 40] = 24;
  view.setUint16(screen + 42, 1, true);
  const visual = screen + 48;
  view.setUint32(visual, 0x21, true);
  bytes[visual + 4] = 4;
  view.setUint32(visual + 8, 0xff0000, true);
  view.setUint32(visual + 12, 0x00ff00, true);
  view.setUint32(visual + 16, 0x0000ff, true);
  return bytes;
}

describe("X11 window capture", () => {
  it("reads the root, resource base, pixel layout and visual masks from the setup reply", () => {
    const setup = parseSetup(setupReply({ lsb: true }), 0);
    expect(setup).toMatchObject({ idBase: 0x0400000, root: 0x2b, lsbImages: true });
    expect(setup?.bitsPerPixel.get(24)).toEqual({ bpp: 32, pad: 32 });
    expect(setup?.visuals.get(0x21)).toEqual({
      trueColor: true,
      red: 0xff0000,
      green: 0x00ff00,
      blue: 0x0000ff,
    });
    // A screen the server does not have is no setup at all.
    expect(parseSetup(setupReply({ lsb: true }), 1)).toBeUndefined();
  });

  it("turns 32-bit pixels into an RGB PNG by the visual's masks", () => {
    const width = 3;
    const height = 2;
    const data = new Uint8Array(width * height * 4);
    const view = new DataView(data.buffer);
    // One red pixel among dark ones, in BGRX order as an LSB server sends them.
    for (let index = 0; index < width * height; index++) view.setUint32(index * 4, 0x101010, true);
    view.setUint32(0, 0xff0000, true);
    const png = zpixmapToPng(data, width, height, width * 4, {
      red: 0xff0000,
      green: 0x00ff00,
      blue: 0x0000ff,
    });
    expect(pngColors(png)).toBe("varied");
    const header = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([header.getUint32(0), header.getUint32(4)]).toEqual([width, height]);
  });
});

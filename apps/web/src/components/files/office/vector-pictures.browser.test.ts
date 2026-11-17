import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../../../test/render";
import { rasterize } from "./vector-pictures";

const svg = (padding = "") =>
  new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><!--${padding}--><rect width="40" height="20" fill="red"/></svg>`,
    ],
    { type: "image/svg+xml" },
  );

describe("rasterize", () => {
  it("draws a small SVG picture at its own size", async () => {
    const { bitmap } = await rasterize({ asset: "small", blob: svg(), size: undefined });

    expect([bitmap?.width, bitmap?.height]).toEqual([40, 20]);
    bitmap?.close();
  });

  it("leaves an SVG picture above the size limit to the engine's placeholder without decoding it", async () => {
    using decode = vi.spyOn(HTMLImageElement.prototype, "decode");
    const picture = await rasterize({
      asset: "huge",
      blob: svg(" ".repeat(3 * 1024 * 1024)),
      size: undefined,
    });

    expect([picture.bitmap, decode.mock.calls.length]).toEqual([undefined, 0]);
  });

  it("stops waiting for an SVG picture whose decode outlasts its time budget", async () => {
    using _decode = vi
      .spyOn(HTMLImageElement.prototype, "decode")
      .mockReturnValue(new Promise(() => {}));
    using _timers = fakeTimers();
    const picture = rasterize({ asset: "slow", blob: svg(), size: undefined });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await picture).toEqual({ asset: "slow", bitmap: undefined });
  });
});

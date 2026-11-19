import { expect, it, vi } from "vite-plus/test";
import { captureDeviceScreenshot } from "./screenshot.ts";

it("returns a complete PNG without a device warning prefix", async () => {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(Uint8Array.from([1, 2, ...png, 3])));
  const image = await captureDeviceScreenshot(
    {
      platform: "android",
      deviceId: "test",
      access: {
        httpBase: "http://device.test",
        wsBase: "ws://device.test",
        query: {},
        credentials: false,
      },
    },
    new AbortController().signal,
  );
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  expect(image.type).toBe("image/png");
});

import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

it("bounds real JPEG stills, preserves pixels and never upscales", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent("<style>body { margin: 0; background: rgb(30, 100, 200) }</style>");
    const cdp = await context.newCDPSession(page);
    const decode = async (jpeg: string) =>
      page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(jpeg)}), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], {type: "image/jpeg"}));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data) };
    })()`) as Promise<{ width: number; height: number; pixel: number[] }>;
    const original = await ServerBrowserPage.captureViewport(cdp, { format: "jpeg", quality: 70 });
    const widthLimited = await ServerBrowserPage.captureViewportWithin(cdp, 70, {
      maxWidth: 480,
      maxHeight: 480,
    });
    const pixels = await decode(widthLimited);
    expect([pixels.width, pixels.height]).toEqual([480, 300]);
    expect(pixels.pixel[0]).toBeGreaterThanOrEqual(25);
    expect(pixels.pixel[0]).toBeLessThanOrEqual(35);
    expect(pixels.pixel[1]).toBeGreaterThanOrEqual(95);
    expect(pixels.pixel[1]).toBeLessThanOrEqual(105);
    expect(pixels.pixel[2]).toBeGreaterThanOrEqual(195);
    expect(pixels.pixel[2]).toBeLessThanOrEqual(205);
    const heightLimited = await decode(
      await ServerBrowserPage.captureViewportWithin(cdp, 70, { maxWidth: 1280, maxHeight: 200 }),
    );
    expect([heightLimited.width, heightLimited.height]).toEqual([320, 200]);
    const fit = await ServerBrowserPage.captureViewportWithin(cdp, 70, {
      maxWidth: 2000,
      maxHeight: 2000,
    });
    expect(fit).toBe(original);
    const fitPixels = await decode(fit);
    expect([fitPixels.width, fitPixels.height]).toEqual([1280, 800]);
    await context.close();
  } finally {
    await browser.close();
  }
});

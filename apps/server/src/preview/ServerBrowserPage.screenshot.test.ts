import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./chromiumInstalled.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe.skipIf(!chromiumInstalled)("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const { screenshot, fullScreenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      fullScreenshot: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 30_000,
    });
    if (screenshot === undefined) throw new Error("Snapshot did not return a screenshot");
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, fullScreenshot, pixels };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, fullScreenshot, pixels } = await screenshotOf(halves(""));

    expect({
      size: [screenshot.width, screenshot.height],
      fullSize: [fullScreenshot?.width, fullScreenshot?.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], fullSize: [2560, 1600], colors: ["blue", "red", "red"] });
  });

  it("reports the real capped frame dimensions without returning image bytes", async () => {
    const page = await context.newPage();
    await page.setContent(halves(""));
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      captureImage: false,
      measureSnapshotFrame: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 30_000,
    });
    expect(result.screenshotSize).toEqual(expect.objectContaining({ width: 1280, height: 800 }));
    expect(result.screenshot).toBeUndefined();
    expect(result.fullScreenshot).toBeUndefined();
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 30_000,
    });

    if (screenshot === undefined) throw new Error("Snapshot did not return a screenshot");
    expect([screenshot.width, screenshot.height]).toEqual([1280, 800]);
  });
});

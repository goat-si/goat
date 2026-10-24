import type { CDPSession, Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { snapshot } from "./ServerBrowserPage.ts";

// PNG fixtures adapted from Emanuele-web04/synara @ 566efb1b1, screenshotCapture.test.ts.
// Copyright (c) 2026 Emanuele Di Pietro. MIT license; see the repository LICENSE.
// Only Chromium I/O is replaced; exercise capture selection, bounds, and metadata together.
const png = (width: number, height: number, bytes = 24) => {
  const data = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data.toString("base64");
};

const fixture = ({ width = 1500, height = 4000, deviceScale = 1 } = {}) => {
  const page = {
    on: vi.fn(),
    mainFrame: () => page,
    frames: () => [page],
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: vi.fn(async () => ({
      url: "https://example.test",
      title: "Fixture",
      loading: false,
      visibleText: "",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => ""),
  };
  const send = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === "Page.getLayoutMetrics")
        return {
          cssContentSize: { width, height },
          contentSize: { width: width * deviceScale, height: height * deviceScale },
          cssVisualViewport: { pageX: 0, pageY: 300 },
        };
      const clip = params?.["clip"] as { width: number; height: number; scale: number } | undefined;
      return {
        data: png(
          Math.round((clip?.width ?? 1280) * deviceScale * (clip?.scale ?? 1)),
          Math.round((clip?.height ?? 800) * deviceScale * (clip?.scale ?? 1)),
        ),
      };
    },
  );
  // The password readers' isolated-world reads answer here, so `send` sees only capture.
  const cdp = {
    send: (method: string, params?: Record<string, unknown>) =>
      method === "Page.getFrameTree"
        ? Promise.resolve({ frameTree: { frame: { id: "main" } } })
        : method === "Page.createIsolatedWorld"
          ? Promise.resolve({ executionContextId: 1 })
          : method === "Runtime.evaluate"
            ? Promise.resolve({ result: { value: [] } })
            : send(method, params),
  };
  const take = (fullPage?: boolean) =>
    snapshot({
      page: page as unknown as Page,
      cdp: cdp as unknown as CDPSession,
      renderScale: deviceScale,
      fullPage,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 15_000,
    });
  return { page, send, take };
};

describe("bounded full-page snapshots", () => {
  it("keeps viewport capture the default", async () => {
    const { take, send } = fixture();
    expect((await take()).screenshot).toMatchObject({ width: 1280, height: 800 });
    expect((await take(false)).screenshot).not.toHaveProperty("fullPage");
    expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    expect(send).not.toHaveBeenCalledWith("Page.getLayoutMetrics");
  });

  it("clips oversized documents at the top-left and reports omitted content", async () => {
    const { take, send } = fixture({ width: 5000, height: 20000 });
    expect((await take(true)).screenshot).toMatchObject({
      width: 3840,
      height: 16384,
      fullPage: true,
      clipped: true,
      byteLength: 24,
    });
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 3840, height: 16384, scale: 1 },
    });
  });

  it("reduces Retina output to CSS resolution without clipping content", async () => {
    const { take, send } = fixture({ deviceScale: 2 });
    expect((await take(true)).screenshot).toMatchObject({
      width: 1500,
      height: 4000,
      clipped: false,
    });
    expect(send).toHaveBeenLastCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 1500, height: 4000, scale: 0.5 },
      }),
    );
  });

  it("bounds actual Retina image pixels and reports clipped document content", async () => {
    const { take } = fixture({ width: 5000, height: 20000, deviceScale: 2 });
    const screenshot = (await take(true)).screenshot;
    const image = Buffer.from(screenshot.data, "base64");
    expect(screenshot).toMatchObject({
      width: 3840,
      height: 16384,
      clipped: true,
      byteLength: image.length,
    });
    expect(image.readUInt32BE(16)).toBe(3840);
    expect(image.readUInt32BE(20)).toBe(16384);
    expect(image.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("rejects images that exceed pixel bounds at every scale", async () => {
    const { take, send } = fixture();
    send
      .mockResolvedValue({ data: png(3841, 16385) })
      .mockResolvedValueOnce({ cssContentSize: { width: 5000, height: 20000 } });
    await expect(take(true)).rejects.toThrow(/3840 × 16384 pixel/);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("reduces scale to meet the byte cap without claiming content was clipped", async () => {
    const { take, send } = fixture();
    send
      .mockResolvedValueOnce({ cssContentSize: { width: 1500, height: 4000 } })
      .mockResolvedValueOnce({ data: png(1500, 4000, 8 * 1024 * 1024 + 1) });
    expect((await take(true)).screenshot).toMatchObject({
      width: 1125,
      height: 3000,
      clipped: false,
    });
    expect(send).toHaveBeenLastCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 1500, height: 4000, scale: 0.75 },
      }),
    );
  });

  it("rejects captures still over the byte budget at every scale", async () => {
    const { take, send } = fixture();
    send
      .mockResolvedValue({ data: png(1500, 4000, 8 * 1024 * 1024 + 1) })
      .mockResolvedValueOnce({ cssContentSize: { width: 1500, height: 4000 } });
    await expect(take(true)).rejects.toThrow(/8 MiB limit/);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("retries unexpected oversized image dimensions using smaller output scales", async () => {
    const { take, send } = fixture();
    send
      .mockResolvedValueOnce({ cssContentSize: { width: 1500, height: 4000 } })
      .mockResolvedValueOnce({ data: png(5000, 20000) });
    expect((await take(true)).screenshot).toMatchObject({ width: 1125, height: 3000 });
  });

  it("rejects malformed PNGs rather than reporting guessed dimensions", async () => {
    const { take, send } = fixture();
    // A snapshot that fails this way is taken once more, so both attempts get the bad PNG.
    for (let attempt = 0; attempt < 2; attempt++)
      send
        .mockResolvedValueOnce({ cssContentSize: { width: 1500, height: 4000 } })
        .mockResolvedValueOnce({ data: "invalid" });
    await expect(take(true)).rejects.toThrow(/invalid full-page PNG/);
  });

  it("drains capture when a semantic read fails before releasing the caller", async () => {
    const { take, send, page } = fixture();
    const started = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<{ data: string }>();
    send
      .mockResolvedValueOnce({ cssContentSize: { width: 1500, height: 4000 } })
      .mockImplementationOnce(() => {
        started.resolve();
        return captured.promise;
      });
    page.ariaSnapshot.mockRejectedValue(new Error("document changed"));
    let settled = false;
    const result = take(true).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started.promise;
    expect(settled).toBe(false);
    captured.resolve({ data: png(1500, 4000) });
    expect(await result).toMatchObject({ message: "document changed" });
  });
});

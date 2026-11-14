import { answerBy, withCaptureLock } from "./CaptureLock.ts";
import { chromium, type CDPSession } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import { SessionControl } from "./SessionControl.ts";
import { captureFinalRecordingFrame } from "./ServerBrowserRecordingFinal.ts";

it("does not capture private tabs or return a frame spanning a private period", async () => {
  const control = new SessionControl("agent");
  const pending = Promise.withResolvers<unknown>();
  const send = vi.fn(() => pending.promise);
  const cdp = { send } as unknown as CDPSession;
  control.setPrivate(true);
  expect(await captureFinalRecordingFrame(cdp, 80, control)).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  control.setPrivate(false);
  const capture = captureFinalRecordingFrame(cdp, 80, control);
  control.setPrivate(true);
  control.setPrivate(false);
  pending.resolve({});
  expect(await capture).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2);
});

it("captures the destination of finite animations without awaiting infinite ones", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      @keyframes enter { from { opacity: 0 } to { opacity: 1 } }
      @keyframes pulse { from { opacity: .5 } to { opacity: 1 } }
      body { margin: 0; background: blue }
      button { animation: pulse 2s infinite }
      #overlay { display: none; position: fixed; inset: 0; background: red }
      #overlay.open { display: block; animation: enter 200ms both }
    </style><button onclick="document.querySelector('#overlay').classList.add('open')">Open</button><div id="overlay"></div>`);
    await page.getByRole("button", { name: "Open" }).click();
    const frame = await captureFinalRecordingFrame(
      await page.context().newCDPSession(page),
      80,
      new SessionControl("agent"),
    );
    expect(frame).toBeDefined();
    const pixel = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(frame)}), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      return Array.from(ctx.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data);
    })()`)) as number[];
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[2]).toBeLessThan(50);
  } finally {
    await browser.close();
  }
});

it("keeps the capture lock until an unanswered final frame settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  using _now = vi.spyOn(performance, "now").mockReturnValue(0);
  const captured = Promise.withResolvers<{ data: string }>();
  const started = Promise.withResolvers<void>();
  const cdp = {
    send: async (method: string) => {
      if (method !== "Page.captureScreenshot") return {};
      started.resolve();
      return captured.promise;
    },
  } as unknown as CDPSession;
  try {
    const tab = { closing: false, captureLock: Promise.resolve() };
    const first = withCaptureLock(tab, () =>
      captureFinalRecordingFrame(cdp, 80, new SessionControl("agent")),
    );
    await started.promise;
    const timed = expect(answerBy(first, 200)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(200);
    await timed;
    let secondStarted = false;
    const second = withCaptureLock(tab, async () => {
      secondStarted = true;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    captured.resolve({ data: "frame" });
    await first;
    await second;
    expect(secondStarted).toBe(true);
  } finally {
    captured.resolve({ data: "cleanup" });
    vi.useRealTimers();
  }
});

import * as NodeVM from "node:vm";
import { vi } from "vite-plus/test";

export function makeEncoderPage<T extends object>(
  page: T,
  encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }>,
) {
  let paintedFrame = "";
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(bitmap: { pixels: string }) {
        paintedFrame = bitmap.pixels;
      },
      fillRect() {},
    }),
    captureStream: (frameRate?: number) => ({
      frameRate,
      getTracks: () => [],
      getVideoTracks: () => [{ requestFrame() {} }],
    }),
  };
  const video = {
    play: async () => {},
    pause() {},
    requestVideoFrameCallback: (callback: () => void) => queueMicrotask(callback),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    mimeType = "video/webm";
    state = "inactive";
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    readonly stream: { frameRate?: number };
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      this.stream = stream;
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([paintedFrame]) });
      this.onstop?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => (tag === "video" ? video : canvas) },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async (blob: Blob) => ({
      width: 1280,
      height: 800,
      pixels: await blob.text(),
      close() {},
    }),
    atob,
    btoa,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

export const mockFinalRecordingFrame = (
  cdp: ReturnType<typeof import("./ServerBrowserTestFixtures.ts").makeSession>,
  refreshFails: boolean,
) => {
  const send = cdp.send.getMockImplementation();
  if (!send) throw new Error("Missing CDP implementation");
  cdp.send.mockImplementation((method, input) => {
    if (method !== "Page.captureScreenshot") return send(method, input);
    return refreshFails
      ? Promise.reject(new Error("Page cannot capture a frame"))
      : Promise.resolve({ data: Buffer.from("final frame").toString("base64") });
  });
};

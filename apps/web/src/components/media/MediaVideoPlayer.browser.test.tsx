import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MediaVideoPlayer } from "./MediaVideoPlayer";

const first = "https://example.com/video.mp4?signature=first";
const second = "https://example.com/video.mp4?signature=second";
const third = "https://example.com/video.mp4?signature=third";

describe("MediaVideoPlayer signed URL recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { headers: { "content-type": "video/mp4" } })),
    );
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(src: string | null, onRetry?: () => Promise<unknown>) {
    await act(async () =>
      root.render(<MediaVideoPlayer src={src} label="sample.mp4" onRetry={onRetry} />),
    );
    return container.querySelector("video")!;
  }

  async function dispatch(video: HTMLVideoElement, type: string) {
    await act(async () => video.dispatchEvent(new Event(type, { bubbles: true })));
  }

  it("adopts a re-signed URL on pause without losing the playhead or controls", async () => {
    const video = await render(first);
    let paused = false;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    video.currentTime = 42;
    video.volume = 0.4;
    video.muted = true;
    video.playbackRate = 1.5;
    await dispatch(video, "play");

    await render(second);
    expect(video.getAttribute("src")).toBe(first);

    paused = true;
    await dispatch(video, "pause");
    expect(video.getAttribute("src")).toBe(second);
    video.currentTime = 0;
    video.volume = 1;
    video.muted = false;
    video.playbackRate = 1;
    await dispatch(video, "loadedmetadata");
    expect(video.currentTime).toBe(42);
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBe(1.5);
  });

  it("preserves a paused playhead across two consecutive signed URL refreshes", async () => {
    const video = await render(first);
    let paused = false;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    await dispatch(video, "play");
    paused = true;
    await dispatch(video, "pause");
    video.currentTime = 42;
    video.volume = 0.4;
    video.muted = true;
    video.playbackRate = 1.5;

    for (const refreshedSrc of [second, third]) {
      await render(refreshedSrc);
      expect(video.getAttribute("src")).toBe(refreshedSrc);
      // A native source replacement resets playback before metadata arrives.
      video.currentTime = 0;
      video.volume = 1;
      video.muted = false;
      video.playbackRate = 1;
      await dispatch(video, "loadedmetadata");
      expect(video.currentTime).toBe(42);
      expect(video.volume).toBe(0.4);
      expect(video.muted).toBe(true);
      expect(video.playbackRate).toBe(1.5);
      expect(video.paused).toBe(true);
    }
    expect(play).not.toHaveBeenCalled();
  });

  it("uses an already renewed URL after a range error and restores playing state once", async () => {
    const video = await render(first);
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    video.currentTime = 83;
    video.volume = 0.25;
    video.muted = true;
    video.playbackRate = 2;
    await dispatch(video, "play");
    await render(second);

    await dispatch(video, "error");
    expect(video.getAttribute("src")).toBe(second);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    video.currentTime = 0;
    await dispatch(video, "loadedmetadata");
    expect(video.currentTime).toBe(83);
    expect(video.volume).toBe(0.25);
    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBe(2);
    expect(play).toHaveBeenCalledOnce();

    await dispatch(video, "canplay");
    await dispatch(video, "error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
  });

  it("shows the fallback when re-signing cannot produce a new URL", async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error("offline"));
    const video = await render(first, onRetry);
    await dispatch(video, "error");

    expect(onRetry).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
  });

  it("uses a re-signed result while a reconnect temporarily removes the latest URL", async () => {
    let finishRefresh: (url: string) => void = () => undefined;
    const onRetry = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const video = await render(first, onRetry);
    await dispatch(video, "error");
    await render(null, onRetry);

    await act(async () => finishRefresh(third));
    expect(container.querySelector("video")?.getAttribute("src")).toBe(third);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("re-signs on error when no newer prop exists, then shows the error if recovery fails", async () => {
    const onRetry = vi.fn().mockResolvedValue(third);
    const video = await render(first, onRetry);
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    video.currentTime = 17;

    await dispatch(video, "error");
    expect(onRetry).toHaveBeenCalledOnce();
    expect(video.getAttribute("src")).toBe(third);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    video.currentTime = 0;
    await dispatch(video, "loadedmetadata");
    expect(video.currentTime).toBe(17);

    await dispatch(video, "error");
    expect(onRetry).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
  });

  it("restores the playhead after a manual retry when the refreshed URL fails again", async () => {
    const onRetry = vi.fn().mockResolvedValue(third);
    const video = await render(first, onRetry);
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    video.currentTime = 17;
    video.volume = 0.3;
    video.playbackRate = 1.25;

    await dispatch(video, "error");
    video.currentTime = 0;
    await dispatch(video, "loadedmetadata");
    expect(video.currentTime).toBe(17);
    // The refreshed URL fails before playback advances, so automatic recovery is spent.
    await dispatch(video, "error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");

    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry video"),
    )!;
    await act(async () => retry.click());
    const retried = container.querySelector("video")!;
    expect(retried.getAttribute("src")).toBe(third);
    retried.currentTime = 0;
    retried.volume = 1;
    retried.playbackRate = 1;
    await dispatch(retried, "loadedmetadata");
    expect(retried.currentTime).toBe(17);
    expect(retried.volume).toBe(0.3);
    expect(retried.playbackRate).toBe(1.25);
  });

  it.each([3, 4])(
    "keeps a format failure explicit after one signed URL refresh (MediaError %i)",
    async (code) => {
      const onRetry = vi.fn().mockResolvedValue(second);
      const video = await render(first, onRetry);
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code }) });
      await dispatch(video, "error");
      expect(video.getAttribute("src")).toBe(second);
      expect(onRetry).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();

      await dispatch(video, "error");
      expect(onRetry).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This video format can't be played here",
      );
      expect(fetch).toHaveBeenCalledWith(second, expect.objectContaining({ method: "HEAD" }));
    },
  );

  it.each([403, 404, 500])(
    "keeps HTTP %i retryable even when the decoder reports an unsupported source",
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
      const video = await render(first);
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 4 }) });
      await dispatch(video, "error");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
      expect(container.textContent).not.toContain("This video format can't be played here");

      const retry = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Retry video"),
      )!;
      await act(async () => retry.click());
      expect(container.querySelector("video")?.getAttribute("src")).toBe(first);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("keeps a disconnected format probe retryable", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    const video = await render(first);
    Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3 }) });
    await dispatch(video, "error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Video unavailable");
    expect(container.textContent).not.toContain("This video format can't be played here");
  });

  it.each([3, 4])(
    "explains a fresh unsupported video (MediaError %i) and keeps its link",
    async (code) => {
      const video = await render(first);
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code }) });
      await dispatch(video, "error");

      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This video format can't be played here",
      );
      expect(
        container.querySelector('a[href="https://example.com/video.mp4?signature=first"]'),
      ).not.toBeNull();
    },
  );
});

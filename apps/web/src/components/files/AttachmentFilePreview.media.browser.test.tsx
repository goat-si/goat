import { EnvironmentId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFilePreview } from "./AttachmentFilePreview";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock("~/assets/assetUrls", () => ({
  resolveAssetUrl: vi.fn(),
  useAssetUrlRefresh: () => refresh,
  useAssetUrlState: vi.fn(),
  useAssetUrls: vi.fn(),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
  writeTextToClipboard: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => true,
  updateClientSettings: vi.fn(async () => true),
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (v: unknown) => v,
}));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const first = "https://environment.test/media?signature=first";
const second = "https://environment.test/media?signature=second";

describe("attachment media preview failures", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refresh.mockReset().mockResolvedValueOnce(first).mockResolvedValue(second);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    container = document.createElement("div");
    container.addEventListener(
      "error",
      (event) => {
        if (event.isTrusted) event.stopImmediatePropagation();
      },
      true,
    );
    container.addEventListener("error", (event) => event.stopPropagation());
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function open(name: string) {
    await act(async () =>
      root.render(
        <AttachmentFilePreview
          name={name}
          mimeType="application/octet-stream"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "media" }}
        />,
      ),
    );
  }

  async function retryImage() {
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry image"),
    )!;
    await act(async () => retry.click());
  }

  it.each(["photo.HEIC", "photo.heif"])(
    "tries to decode %s and offers the original file when the format is unsupported",
    async (name) => {
      await open(name);
      const image = container.querySelector("img")!;
      await act(async () => image.dispatchEvent(new Event("load", { bubbles: true })));
      expect(container.querySelector("img")).toBe(image);
      expect(fetch).not.toHaveBeenCalled();

      await act(async () => image.dispatchEvent(new Event("error", { bubbles: true })));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This image format can't be displayed here",
      );
      expect(fetch).toHaveBeenCalledWith(first, expect.objectContaining({ method: "HEAD" }));
      expect(container.querySelector("a")?.getAttribute("href")).toBe(first);
      expect(container.querySelector('button[aria-label="Save file"]')).not.toBeNull();

      await retryImage();
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(second);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each([403, 404, 500])("keeps an HTTP %i image failure retryable", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    await open("photo.heic");
    await act(async () =>
      container.querySelector("img")!.dispatchEvent(new Event("error", { bubbles: true })),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("This image format can't be displayed here");

    await retryImage();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(second);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([3, 4])(
    "explains an undecodable video after one URL refresh (MediaError %i)",
    async (code) => {
      await open("clip.mov");
      const video = container.querySelector("video")!;
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code }) });
      await act(async () => video.dispatchEvent(new Event("error", { bubbles: true })));
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(video.getAttribute("src")).toBe(second);
      expect(fetch).not.toHaveBeenCalled();

      await act(async () => video.dispatchEvent(new Event("error", { bubbles: true })));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This video format can't be played here",
      );
      expect(fetch).toHaveBeenCalledWith(second, expect.objectContaining({ method: "HEAD" }));
      expect(container.querySelector('button[aria-label="Save file"]')).not.toBeNull();
      expect(container.querySelector("a")?.getAttribute("href")).toBe(second);
    },
  );
});

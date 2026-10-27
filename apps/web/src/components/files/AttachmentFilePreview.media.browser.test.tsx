import { EnvironmentId } from "@goat/contracts";
import type { ClientSettings } from "@goat/contracts/settings";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render, stubGlobal, type Screen } from "../../../test/render";

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
vi.mock("~/hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@goat/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: ClientSettings) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
    updateClientSettings: vi.fn(async () => true),
    ensureClientSettingsHydrated: vi.fn(async () => undefined),
    isClientSettingsHydrated: () => true,
    getClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  };
});
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

function open(name: string) {
  refresh.mockReset().mockResolvedValueOnce(first).mockResolvedValue(second);
  const container = document.createElement("div");
  container.addEventListener(
    "error",
    (event) => {
      if (event.isTrusted) event.stopImmediatePropagation();
    },
    true,
  );
  container.addEventListener("error", (event) => event.stopPropagation());
  return render(
    <AttachmentFilePreview
      name={name}
      mimeType="application/octet-stream"
      sizeBytes={100}
      asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "media" }}
    />,
    { container },
  );
}

async function retryImage(screen: Screen) {
  await userEvent.click(screen.getByRole("button", { name: "Retry image" }));
}

describe("attachment media preview failures", () => {
  it.each(["photo.HEIC", "photo.heif"])(
    "tries to decode %s and offers the original file when the format is unsupported",
    async (name) => {
      await using screen = await open(name);
      const { container } = screen;
      using _fetch = stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
      const image = container.querySelector("img")!;
      await act(async () => image.dispatchEvent(new Event("load", { bubbles: true })));
      expect(container.querySelector("img")).toBe(image);
      expect(fetch).not.toHaveBeenCalled();

      await act(async () => image.dispatchEvent(new Event("error", { bubbles: true })));
      await expect
        .element(screen.getByRole("alert"))
        .toMatchTextContent("This image format can't be displayed here");
      expect(fetch).toHaveBeenCalledWith(first, expect.objectContaining({ method: "HEAD" }));
      await expect.element(screen.getByRole("link")).toHaveAttribute("href", first);
      await expect.element(screen.getByRole("button", { name: "Save file" })).toBeVisible();

      await retryImage(screen);
      expect(refresh).toHaveBeenCalledTimes(2);
      await expect.element(screen.getByAltText(name)).toHaveAttribute("src", second);
      await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each([403, 404, 500])("keeps an HTTP %i image failure retryable", async (status) => {
    await using screen = await open("photo.heic");
    const { container } = screen;
    using _fetch = stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await act(async () =>
      container.querySelector("img")!.dispatchEvent(new Event("error", { bubbles: true })),
    );
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect
      .element(screen.getByRole("alert"))
      .not.toMatchTextContent("This image format can't be displayed here");

    await retryImage(screen);
    await expect.element(screen.getByAltText("photo.heic")).toHaveAttribute("src", second);
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it.each([3, 4])(
    "explains an undecodable video after one URL refresh (MediaError %i)",
    async (code) => {
      await using screen = await open("clip.mov");
      const { container } = screen;
      using _fetch = stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
      using _pause = vi
        .spyOn(HTMLMediaElement.prototype, "pause")
        .mockImplementation(() => undefined);
      const video = container.querySelector("video")!;
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code }) });
      await act(async () => video.dispatchEvent(new Event("error", { bubbles: true })));
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(video.getAttribute("src")).toBe(second);
      expect(fetch).not.toHaveBeenCalled();

      await act(async () => video.dispatchEvent(new Event("error", { bubbles: true })));
      await expect
        .element(screen.getByRole("alert"))
        .toMatchTextContent("This video format can't be played here");
      expect(fetch).toHaveBeenCalledWith(second, expect.objectContaining({ method: "HEAD" }));
      await expect.element(screen.getByRole("button", { name: "Save file" })).toBeVisible();
      await expect.element(screen.getByRole("link")).toHaveAttribute("href", second);
    },
  );
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MediaImagePreview } from "./MediaImagePreview";

// A decodable image from the test server: with a remote URL the browser's own load can fail
// the retried <img> and remove it before an assertion reads it.
const first = new URL("/favicon-16x16.png?signature=first", location.origin).href;
const second = new URL("/favicon-16x16.png?signature=second", location.origin).href;

describe("HEIC and HEIF image previews", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { headers: { "content-type": "image/heic" } })),
    );
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

  async function render(
    src: string | null = first,
    name = "photo.HEIC",
    options: { sourceFailed?: boolean; mimeType?: string; onRetry?: () => Promise<unknown> } = {},
  ) {
    await act(async () => root.render(<MediaImagePreview src={src} name={name} {...options} />));
    return container.querySelector("img")!;
  }

  async function fail(image: HTMLImageElement) {
    await act(async () => image.dispatchEvent(new Event("error", { bubbles: true })));
  }

  it.each(["photo.HEIC", "photo.heif"])(
    "lets the platform decode %s before reporting a format failure",
    async (name) => {
      const image = await render(first, name);
      await act(async () => image.dispatchEvent(new Event("load", { bubbles: true })));
      expect(container.querySelector("img")).toBe(image);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();

      await fail(image);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "This image format can't be displayed here",
      );
      expect(container.querySelector("a")?.href).toBe(first);
      expect(fetch).toHaveBeenCalledWith(first, expect.objectContaining({ method: "HEAD" }));
    },
  );

  it.each([
    ["photo", "image/heif"],
    ["photo.HEIC", "application/octet-stream"],
    ["photo.heif", "text/plain"],
  ])("recognizes %s with MIME type %s on decode failure", async (name, mimeType) => {
    await fail(await render(first, name, { mimeType }));
    expect(container.textContent).toContain("This image format can't be displayed here");
  });

  it.each([403, 404, 500])("keeps HTTP %i as a load failure with retry", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    await fail(await render());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load workspace image",
    );
    expect(container.textContent).not.toContain("This image format can't be displayed here");

    const retry = container.querySelector("button")!;
    await act(async () => retry.click());
    expect(container.querySelector("img")?.getAttribute("src")).toBe(first);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a dead connection retryable", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
    await fail(await render());
    expect(container.textContent).toContain("Unable to load workspace image");
    expect(container.textContent).not.toContain("This image format can't be displayed here");
  });

  it("does not classify an unavailable signed source as a format failure", async () => {
    await render(null, "photo.heic", { sourceFailed: true });
    expect(container.textContent).toContain("Unable to load workspace image");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a previous failed source replace a refreshed preview", async () => {
    let finishProbe: (response: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishProbe = resolve;
        }),
    );
    await fail(await render());
    await render(second);
    await act(async () => finishProbe(new Response(null)));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(second);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("retries a failed image and retains its error when reauthorization fails", async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error("offline"));
    await fail(await render(first, "photo.heic", { onRetry }));
    await act(async () => container.querySelector("button")!.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    onRetry.mockResolvedValue(second);
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps ordinary image failures on the existing retry path", async () => {
    await fail(await render(first, "photo.png"));
    expect(container.textContent).toContain("Unable to load workspace image");
    expect(fetch).not.toHaveBeenCalled();
  });
});

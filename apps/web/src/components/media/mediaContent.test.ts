import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isMediaSourceAvailable } from "./mediaContent";

afterEach(() => vi.unstubAllGlobals());

describe("failed media source availability", () => {
  it("checks HTTP headers without downloading media bytes", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { "content-type": "video/quicktime" } }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    expect(await isMediaSourceAvailable("https://example.com/clip.mov", controller.signal)).toBe(
      true,
    );
    expect(request).toHaveBeenCalledWith("https://example.com/clip.mov", {
      method: "HEAD",
      signal: controller.signal,
    });
  });

  it("treats a login page as a load failure rather than an unsupported codec", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { headers: { "content-type": "text/html; charset=utf-8" } }),
        ),
    );
    expect(
      await isMediaSourceAvailable("https://example.com/clip.mov", new AbortController().signal),
    ).toBe(false);
  });

  it("checks a local Blob without consuming its body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/heic" }),
        body: { cancel },
      }),
    );
    const controller = new AbortController();
    expect(await isMediaSourceAvailable("blob:https://example.com/local", controller.signal)).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledWith("blob:https://example.com/local", {
      method: "GET",
      signal: controller.signal,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves revoked Blob URLs on the retryable load failure path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("revoked Blob")));
    expect(
      await isMediaSourceAvailable(
        "blob:https://example.com/revoked",
        new AbortController().signal,
      ),
    ).toBe(false);
  });
});

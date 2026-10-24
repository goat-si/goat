import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cliReleasePublishedAtom } from "./npmRelease";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = cliReleasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("cliReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks GOAT release assets without consulting either unrelated npm package", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        tag_name: `v${version}`,
        draft: false,
        assets: [
          "SHA256SUMS",
          ...["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"].map(
            (key) => `goat-${version}-${key}.${key.startsWith("win32") ? "zip" : "tar.gz"}`,
          ),
        ].map((name) => ({ name })),
      }),
    );

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/goat-si/goat-releases/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  // regression: #18709 update-everything skipped npm-installed servers
  it.each([
    { tag_name: `v${version}`, draft: true, assets: [] },
    { tag_name: "v9.9.9", draft: false, assets: [] },
    { tag_name: `v${version}`, draft: false, assets: [{ name: "SHA256SUMS" }] },
    { version },
  ])("does not offer an absent or incomplete GOAT release: %j", async (body) => {
    fetchMock.mockImplementation(async () => Response.json(body));
    expect(AsyncResult.getOrElse(await settledCheck(), () => false)).toBe(false);
  });

  it("does not offer a release that returns 404", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(AsyncResult.getOrElse(await settledCheck(), () => false)).toBe(false);
  });

  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});

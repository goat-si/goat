import { SshConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildExpandedImagePreview, resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["t3code:", "https:"],
    ["t3code-dev:", "https:"],
    ["http:", "http:"],
    ["https:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    async (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = await resolveMarkdownMediaPreview({
        source,
        createAssetUrl: async () => {
          throw new Error("Remote media must not request a local asset URL.");
        },
      });

      expect(preview?.images[0]).toMatchObject({
        src: `${mediaProtocol}${source}`,
        originalUrl: source,
        actionsSource: {
          src: `${mediaProtocol}${source}`,
          reference: { kind: "url", url: source },
        },
      });
    },
  );

  it("refuses a remote environment's localhost media this device cannot reach, with the reason", async () => {
    const preview = resolveMarkdownMediaPreview({
      source: "http://localhost:5173/full.png",
      environmentConnection: {
        connection: {
          target: new SshConnectionTarget({
            environmentId: EnvironmentId.make("environment-1"),
            label: "Build box",
            connectionId: "ssh:box",
          }),
          httpBaseUrl: "http://127.0.0.1:41234",
        },
        isDesktopRenderer: false,
        normalizeUri: (uri) => uri,
      },
      createAssetUrl: async () => {
        throw new Error("Remote media must not request a local asset URL.");
      },
    });
    await expect(preview).rejects.toThrow(/localhost:5173 is on Build box/);
  });
});

describe("buildExpandedImagePreview", () => {
  it("keeps MIME type for stored images without a filename extension", () => {
    const preview = buildExpandedImagePreview(
      [
        {
          type: "image",
          id: "heic-1",
          name: "photo",
          mimeType: "image/heic",
          sizeBytes: 3,
          previewUrl: "blob:heic",
        },
      ],
      "heic-1",
    );
    expect(preview?.images[0]).toMatchObject({
      name: "photo",
      mimeType: "image/heic",
      src: "blob:heic",
    });
  });
});

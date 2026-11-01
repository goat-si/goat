import { describe, expect, it } from "vite-plus/test";
import { SCREEN_TARGET_CONTRACT_VERSION, screenTargetApi } from "@goat/contracts";

import { screenRunMcpResult } from "./result.ts";

const bytes = Buffer.from("image payload").toString("base64");
const image = {
  imageRef: "image-1",
  callId: 1,
  targetId: "tab-1",
  observationId: "observation-1",
  regionId: "viewport-1",
  region: { kind: "viewport" as const, x: 0, y: 0, width: 1, height: 1 },
  pixelWidth: 1,
  pixelHeight: 1,
  scale: 1,
  mimeType: "image/png" as const,
};

describe("screen run MCP result", () => {
  it("describes state and target lifetimes across cells and turns", () => {
    const api = screenTargetApi({ app: true, tab: true });
    expect(api).toContain("state values survive later turns");
    expect(api).toContain("targets must be bound again each turn");
    expect(api).toContain("rebinding the same unmoved window returns the same target");
    expect(api).toContain("A refused stale target names why and the call to bind it again.");
  });
  it.each([
    { hasApi: false, hasImage: false },
    { hasApi: true, hasImage: false },
    { hasApi: false, hasImage: true },
    { hasApi: true, hasImage: true },
  ])(
    "preserves the complete summary and images for $hasApi API and $hasImage image",
    ({ hasApi, hasImage }) => {
      const api = screenTargetApi({ app: true, tab: true });
      expect(api.length).toBeLessThanOrEqual(16 * 1024);
      const input = {
        runId: "run-1",
        turnId: "turn-1",
        cellId: "cell-1",
        status: "completed",
        console: [],
        journal: [],
        truncated: [],
        availability: [{ kind: "tab", available: true }],
        imageMetadata: hasImage ? [image] : [],
        images: hasImage ? [{ ...image, bytes }] : [],
        ...(hasApi ? { api, contractVersion: SCREEN_TARGET_CONTRACT_VERSION } : {}),
      };
      const result = screenRunMcpResult(input);
      const { images: _images, ...summary } = input;
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(hasApi || hasImage ? undefined : summary);
      const texts = result.content.filter((block) => block.type === "text");
      expect(texts).toHaveLength(1);
      expect(JSON.parse(texts[0]!.text)).toEqual(summary);
      expect(JSON.stringify(texts)).not.toContain(bytes);
      expect(result.content.filter((block) => block.type === "image")).toHaveLength(
        hasImage ? 1 : 0,
      );
    },
  );
});

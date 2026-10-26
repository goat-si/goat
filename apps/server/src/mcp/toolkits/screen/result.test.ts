import { describe, expect, it } from "vite-plus/test";

import { screenRunMcpResult } from "./result.ts";

describe("screen run MCP result", () => {
  it("returns retained image blocks and a bytes-free summary", () => {
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
    const result = screenRunMcpResult({
      runId: "run-1",
      turnId: "turn-1",
      cellId: "cell-1",
      status: "completed",
      console: [],
      journal: [],
      truncated: [],
      availability: [{ kind: "tab", available: true }],
      imageMetadata: [image],
      images: [{ ...image, bytes }],
    });
    expect(result.isError).toBe(false);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
    expect(result.content.find((block) => block.type === "image")).toMatchObject({ mimeType: "image/png" });
    const summary = JSON.stringify(result.structuredContent);
    expect(summary).not.toContain(bytes);
    expect(summary).not.toContain('"bytes"');
    expect(JSON.stringify(result.content.find((block) => block.type === "text"))).not.toContain(bytes);
  });
});

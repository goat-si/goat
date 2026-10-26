import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import {
  turnItemHasDetail,
  turnItemOutputImages,
  turnItemOutputLinks,
  turnItemOutputText,
} from "./itemDetail.ts";

function toolItem(output: unknown): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("images"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName: "screenshots",
    input: {},
    output,
  };
}

describe("tool image output parsing", () => {
  it.each(["array", "content"] as const)(
    "keeps markers for images beyond the served positions in %s output",
    (shape) => {
      // Detail responses retain image metadata after the server strips image bytes.
      const image = { type: "image", mimeType: "image/png" };
      const blocks = Array.from({ length: 8 }, () => ({ ...image }));
      const wrap = (content: unknown[]) => (shape === "array" ? content : { content });
      const withinLimit = toolItem(wrap(blocks));
      expect(turnItemOutputText(withinLimit)).toBeNull();
      expect(turnItemOutputImages(withinLimit)).toHaveLength(8);

      const overflow = toolItem(
        wrap([
          ...blocks,
          { type: "text", text: "Two additional screenshots:" },
          { ...image, sizeBytes: 100 },
          { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
        ]),
      );
      expect(turnItemOutputImages(overflow)).toHaveLength(8);
      expect(turnItemOutputText(overflow)).toBe("Two additional screenshots:\n[image]\n[image]");
    },
  );
});

describe("MCP resource link output", () => {
  const link = { type: "resource_link", uri: "https://example.com/report", name: "report" };
  const uriOnlyResource = { type: "resource", resource: { uri: "file:///tmp/notes.md" } };
  const textResource = { type: "resource", resource: { uri: "file:///tmp/a.md", text: "body" } };

  it.each([
    ["an array", (blocks: unknown[]) => blocks],
    ["a content wrapper", (blocks: unknown[]) => ({ content: blocks })],
    [
      "a content and structuredContent wrapper",
      (blocks: unknown[]) => ({ content: blocks, structuredContent: { ok: true } }),
    ],
  ])("lists links once in %s and keeps embedded resource text", (_shape, wrap) => {
    const item = toolItem(
      wrap([{ type: "text", text: "Saved" }, link, uriOnlyResource, textResource]),
    );
    expect(turnItemOutputLinks(item)).toEqual([
      { uri: "https://example.com/report", name: "report" },
      { uri: "file:///tmp/notes.md", name: "file:///tmp/notes.md" },
    ]);
    expect(turnItemOutputText(item, { omitLinks: true })).toBe("Saved\nbody");
    // Clients without a link list, such as mobile, still read the URIs as text.
    expect(turnItemOutputText(item)).toBe(
      "Saved\nhttps://example.com/report\nfile:///tmp/notes.md\nbody",
    );
  });

  it("does not fall back to JSON when a structured result holds only links", () => {
    const item = toolItem({ content: [link], structuredContent: { id: 7 } });
    expect(turnItemOutputText(item, { omitLinks: true })).toBeNull();
    expect(turnItemOutputLinks(item)).toHaveLength(1);
  });

  it("makes a call with no input expandable when its output is only links", () => {
    expect(turnItemHasDetail(toolItem([link]))).toBe(true);
    expect(turnItemHasDetail(toolItem([]))).toBe(false);
  });
});

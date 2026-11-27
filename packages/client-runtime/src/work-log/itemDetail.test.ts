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

it("shows structured MCP output with its image and retains resource links", () => {
  const item = toolItem({
    content: [
      { type: "text", text: "fallback" },
      { type: "image", mimeType: "image/png" },
      { type: "resource_link", uri: "https://example.com/report", name: "report" },
    ],
    structuredContent: { status: "ready" },
  });
  expect(turnItemOutputImages(item)).toHaveLength(1);
  expect(turnItemOutputText(item)).toBe(
    '{\n  "status": "ready"\n}\nfallback\nhttps://example.com/report',
  );
  expect(turnItemOutputText(item, { omitLinks: true })).toBe('{\n  "status": "ready"\n}\nfallback');
});

it("keeps warnings beside structured MCP output and an image", () => {
  const item = toolItem({
    content: [
      { type: "image", mimeType: "image/png" },
      { type: "text", text: "Warning: partial result" },
    ],
    structuredContent: { status: "ok" },
  });
  expect(turnItemOutputImages(item)).toHaveLength(1);
  expect(turnItemOutputText(item)).toBe('{\n  "status": "ok"\n}\nWarning: partial result');
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

describe("MCP app tool output", () => {
  it("shows the tool result, not the app wrapper", () => {
    const text = "Notice\nview\tcount\n/home\t42";
    const item = toolItem({
      goatMcpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "aggregate_rum_events",
        resourceUri: "ui://repro/dataviz",
      },
      result: { content: [{ type: "text", text }] },
    });
    expect(turnItemOutputText(item)).toBe(text);
  });

  it("shows the tool result for a row saved under the legacy app key", () => {
    const item = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "aggregate_rum_events",
        resourceUri: "ui://repro/dataviz",
      },
      result: { content: [{ type: "text", text: "legacy result" }] },
    });
    expect(turnItemOutputText(item)).toBe("legacy result");
  });

  it("reads a result with metadata and marks images it cannot preview", () => {
    const item = toolItem({
      goatMcpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "chart",
        resourceUri: "ui://repro/chart",
      },
      result: {
        content: [
          { type: "text", text: "chart" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
        _meta: { "ui/resourceUri": "ui://repro/chart" },
      },
    });
    expect(turnItemOutputText(item)).toBe("chart\n[image]");

    const bounded = toolItem({
      goatMcpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "chart",
        resourceUri: "ui://repro/chart",
      },
      result: [
        { type: "text", text: "chart" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(turnItemOutputText(bounded)).toBe("chart\n[image]");
  });
});

describe("tool text output formatting", () => {
  it.each([
    '{"id":1234567890123456789,"name":"x"}',
    '{"id":1}\n{"id":-9007199254740993}',
    '{"id":9.007199254740993e15}',
    '{"id":1e309}',
  ])("keeps %j as returned when parsing would change a number", (text) => {
    expect(turnItemOutputText(toolItem({ content: [{ type: "text", text }] }))).toBe(text);
  });
  it("formats JSON when a large number appears only in a string", () => {
    const text = '{"id":42,"note":"12345678901234567890"}';
    expect(turnItemOutputText(toolItem({ content: [{ type: "text", text }] }))).toBe(
      JSON.stringify(JSON.parse(text), null, 2),
    );
  });
});

describe("file search output text", () => {
  function searchItem(
    results: Extract<OrchestrationV2TurnItem, { type: "file_search" }>["results"],
  ): OrchestrationV2TurnItem {
    const {
      toolName: _toolName,
      input: _input,
      output: _output,
      ...base
    } = toolItem(null) as Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
    return { ...base, type: "file_search", pattern: "needle", results };
  }

  it("prints matches under one heading per file", () => {
    expect(
      turnItemOutputText(
        searchItem([
          { fileName: "src/one.ts", line: 2, preview: "  const needle = 1;" },
          { fileName: "src/two.ts", line: 7, column: 3, preview: "needle()" },
          { fileName: "src/one.ts", line: 9, preview: "return needle;" },
        ]),
      ),
    ).toBe("src/one.ts\n2:   const needle = 1;\n9: return needle;\n\nsrc/two.ts\n7:3: needle()");
  });

  it("keeps a plain file list one path per line", () => {
    expect(turnItemOutputText(searchItem([{ fileName: "a.ts" }, { fileName: "b.ts" }]))).toBe(
      "a.ts\nb.ts",
    );
  });
});

import { assert, describe, it } from "@effect/vitest";
import { toolOutputImages } from "@goat/shared/toolOutput";

import { codexToolOutput } from "./CodexToolOutput.ts";

const SCREENSHOT = "iVBORw0KGgo=";

describe("codexToolOutput", () => {
  it("regression: keeps the screenshot an MCP tool returned beside its structured output", () => {
    // The shape cua-driver's get_window_state returns: the screenshot only in content.
    const output = codexToolOutput({
      type: "mcpToolCall",
      id: "cua-window-state",
      server: "cua-driver",
      tool: "get_window_state",
      status: "completed",
      arguments: { pid: 501, window_id: 7 },
      result: {
        content: [
          { type: "text", text: "Finder, 1 window" },
          { type: "image", mimeType: "image/png", data: SCREENSHOT },
        ],
        structuredContent: { app: "Finder", windowId: 7 },
      },
    });
    assert.deepEqual(toolOutputImages(output), [{ mimeType: "image/png", data: SCREENSHOT }]);
    assert.deepEqual((output as { readonly structuredContent?: unknown }).structuredContent, {
      app: "Finder",
      windowId: 7,
    });
  });

  it("regression: reads a dynamic tool's data URL image as an image block", () => {
    const output = codexToolOutput({
      type: "dynamicToolCall",
      id: "dynamic-screenshot",
      namespace: "viewer",
      tool: "capture",
      status: "completed",
      arguments: {},
      success: true,
      contentItems: [
        { type: "inputText", text: "Captured" },
        { type: "inputImage", imageUrl: `data:image/png;base64,${SCREENSHOT}` },
      ],
    });
    assert.deepEqual(toolOutputImages(output), [{ mimeType: "image/png", data: SCREENSHOT }]);
  });
});

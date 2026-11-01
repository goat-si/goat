import { describe, expect, it } from "vite-plus/test";

import { imageToolSuccess } from "./imageToolResult.ts";

const encoded = {
  deviceId: "UDID-1",
  screenshot: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 2, height: 1 },
};
const metadata = {
  deviceId: "UDID-1",
  screenshot: { mimeType: "image/png", width: 2, height: 1 },
};

describe("imageToolSuccess", () => {
  it("contract: a screenshot result has image content and no structuredContent, so Codex shows the model the image", () => {
    // Codex sends the model only structuredContent when a result has it (openai/codex
    // codex-rs/protocol/src/models.rs as_function_call_output_payload).
    const result = imageToolSuccess({}, encoded);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    const [text] = result.content;
    expect(text?.type === "text" ? JSON.parse(text.text) : null).toEqual(metadata);
  });

  it("contract: a text-only result keeps its metadata structured and carries no image bytes", () => {
    const result = imageToolSuccess({ includeImage: false }, encoded);
    expect(result.structuredContent).toEqual(metadata);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(JSON.stringify(result)).not.toContain("iVBORw0KGgo=");
  });
});

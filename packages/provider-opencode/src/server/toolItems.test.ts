import { assert, describe, it } from "@effect/vitest";
import { TurnItemId, ThreadId } from "@goat/contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  MAX_TOOL_OUTPUT_IMAGES,
} from "@goat/shared/toolOutput";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";

import { openCodeFileUris, openCodeToolStateResult, openCodeToolTurnItem } from "./toolItems.ts";

const oversize = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
// An image, a non-image, a file path, an oversize image, then more images than one output keeps.
const files = [
  { url: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
  { url: "data:application/pdf;base64,JVBERi0=", mime: "application/pdf" },
  { url: "file:///tmp/capture.png", mime: "image/png" },
  { url: `data:image/png;base64,${oversize}`, mime: "image/png" },
  ...Array.from({ length: 10 }, () => ({
    url: "data:image/jpeg;base64,/9j/4AAQ",
    mime: "image/jpeg",
  })),
];
// Oversize bytes stay for the tool-output asset path, which strips what it will not serve.
const expected = [
  { type: "text", text: "Captured the screen" },
  { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  { type: "image", mimeType: "image/png", data: oversize },
  ...Array.from({ length: MAX_TOOL_OUTPUT_IMAGES - 2 }, () => ({
    type: "image",
    mimeType: "image/jpeg",
    data: "/9j/4AAQ",
  })),
];

const now = DateTime.makeUnsafe(0);
const project = (output: string | undefined, fileUrls: ReadonlyArray<string> | undefined) => {
  const item = openCodeToolTurnItem(
    {
      id: TurnItemId.make("item:shot"),
      threadId: ThreadId.make("thread:shot"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Screenshot",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
    { name: "cua-driver_screenshot", input: {}, output, fileUrls, completedMetadata: {} },
  );
  return item.type === "dynamic_tool" ? item.output : undefined;
};

describe("OpenCode MCP image output", () => {
  it("keeps an OpenCode 1 tool's image attachments as image blocks after its text", () => {
    const state = {
      status: "completed",
      input: {},
      title: "Screenshot",
      metadata: {},
      output: "Captured the screen",
      time: { start: 1, end: 2 },
      attachments: files.map((file, index) => ({
        ...file,
        id: `file-${index}`,
        sessionID: "session",
        messageID: "message",
        type: "file" as const,
      })),
    } satisfies ToolPart["state"];
    const { output, fileUrls } = openCodeToolStateResult(state);
    assert.deepEqual(project(output, fileUrls), expected);
    const { attachments: _, ...textOnly } = state;
    const plain = openCodeToolStateResult(textOnly);
    assert.equal(project(plain.output, plain.fileUrls), "Captured the screen");
  });

  it("keeps an OpenCode 2 tool's image file content as image blocks after its text", () => {
    const content = [
      { type: "text", text: "Captured the screen" },
      ...files.map((file) => ({ type: "file", uri: file.url, mime: file.mime })),
    ];
    assert.deepEqual(project("Captured the screen", openCodeFileUris(content)), expected);
  });
});

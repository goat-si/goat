import { assert, describe, it } from "@effect/vitest";
import { TurnItemId, ThreadId } from "@goat/contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  MAX_TOOL_OUTPUT_IMAGES,
} from "@goat/shared/toolOutput";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import * as DateTime from "effect/DateTime";

import {
  openCodeFileUris,
  openCodeToolStateResult,
  openCodeToolStatus,
  openCodeToolTurnItem,
} from "./toolItems.ts";

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
const project = (
  output: string | undefined,
  fileUrls: ReadonlyArray<string> | undefined,
  name = "cua-driver_screenshot",
) => {
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
    { name, input: {}, output, fileUrls, completedMetadata: {} },
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

it("keeps file-named MCP tools as dynamic output instead of file edits", () => {
  assert.deepEqual(project("Captured the screen", [files[0]!.url], "mcp__screen__write"), [
    { type: "text", text: "Captured the screen" },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  ]);
});

describe("OpenCode interrupted tools", () => {
  it("distinguishes interrupted tools and tasks from failures", () => {
    for (const [tool, error, metadata, expected] of [
      ["bash", "Interrupted", { interrupted: true }, "interrupted"],
      ["bash", "Tool execution aborted", undefined, "interrupted"],
      ["task", "Task cancelled", undefined, "interrupted"],
      ["task", "Task failed", undefined, "failed"],
      ["bash", "Command failed", undefined, "failed"],
    ] as const) {
      const part = {
        id: "part",
        sessionID: "session",
        messageID: "message",
        type: "tool",
        callID: "call",
        tool,
        state: {
          status: "error",
          input: {},
          error,
          time: { start: 1, end: 2 },
          ...(metadata ? { metadata } : {}),
        },
      } satisfies ToolPart;
      assert.deepEqual(openCodeToolStatus(part), { node: expected, item: expected });
    }
  });
});

describe("openCodeToolTurnItem", () => {
  it.each([
    {
      name: "deletion",
      toolName: "edit",
      input: { oldString: "old\n", newString: "", newText: "fallback" },
      expected: { oldStr: "old\n", newStr: "" },
    },
    {
      name: "whitespace replacement",
      toolName: "edit",
      input: { oldString: " \t", newString: "\n\t" },
      expected: { oldStr: " \t", newStr: "\n\t" },
    },
    {
      name: "empty write",
      toolName: "write",
      input: { content: "" },
      expected: { newStr: "" },
    },
  ])("preserves exact file content for $name", ({ toolName, input, expected }) => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("tool-item"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: toolName,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
      },
      {
        name: toolName,
        input: { filePath: "src/index.ts", ...input },
        output: undefined,
        completedMetadata: undefined,
      },
    );
    assert.deepInclude(item, { type: "file_change", fileName: "src/index.ts", ...expected });
  });
});

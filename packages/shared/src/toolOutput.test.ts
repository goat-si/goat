import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  imageBlockFromDataUrl,
  MAX_TOOL_OUTPUT_IMAGES,
  mcpToolResultWithRawImages,
  mcpToolResultOutput,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
  toolOutputSettle,
} from "./toolOutput.ts";

describe("toolOutputSettle", () => {
  const expected = { outcome: "unsupported", reason: "private_or_unknown_focus" };
  const summary =
    "Notification settle: unsupported (private_or_unknown_focus). Quiet does not establish task completion.";

  it("reads a settle wait's outcome from every provider's result shape (#1585)", () => {
    const shapes: ReadonlyArray<readonly [string, unknown]> = [
      [
        "MCP result",
        { content: [{ type: "text", text: summary }], structuredContent: { settle: expected } },
      ],
      ["OpenCode plain string", summary],
      ["Cursor text parts", { content: [{ text: { text: summary } }] }],
      ["ACP content wrappers", [{ type: "content", content: { type: "text", text: summary } }]],
      [
        "structured fields folded beside a screenshot",
        [
          { type: "text", text: JSON.stringify({ pid: 1, settle: expected }) },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
      ],
      ["compact wire output", { settle: expected }],
    ];
    for (const [name, output] of shapes) expect(toolOutputSettle(output), name).toEqual(expected);
  });

  it("finds the outcome beside a sample too large to parse", () => {
    const pending = { outcome: "pending", reason: "deadline" };
    const line =
      "Notification settle: pending (deadline). Quiet does not establish task completion.";
    const folded = JSON.stringify({ tree: "x".repeat(20_000), settle: pending });
    // GOAT folds the structured sample in front of the content when a screenshot remains.
    expect(
      toolOutputSettle([
        { type: "text", text: folded },
        { type: "text", text: line },
      ]),
    ).toEqual(pending);
    // A provider that joins the text into one string puts the folded sample first.
    expect(toolOutputSettle(folded + "\n" + line)).toEqual(pending);
    // A window title can contain the same words; the real line at a line start still counts.
    const titled = JSON.stringify({
      window_title: "Notification settle: example",
      tree: "x".repeat(20_000),
      settle: pending,
    });
    expect(toolOutputSettle(titled + "\n" + line)).toEqual(pending);
    expect(
      compactDynamicToolOutput({
        content: [
          { type: "text", text: folded },
          { type: "text", text: line },
        ],
      })?.settle,
    ).toEqual(pending);
  });

  it("reads a reason that lists several privacy problems", () => {
    const reason =
      "private_or_unknown_focus:tree_children_unreadable:AXGroup:err25204,tree_role:AXUnknown,tree_subrole:AXTextField";
    expect(
      toolOutputSettle(
        `Notification settle: unsupported (${reason}). Quiet does not establish task completion.`,
      ),
    ).toEqual({ outcome: "unsupported", reason });
  });

  it("reads a reason that names an AX notification", () => {
    const reason = { outcome: "unsupported", reason: "notification_unsupported:AXMoved" };
    const line =
      "Notification settle: unsupported (notification_unsupported:AXMoved). Quiet does not establish task completion.";
    expect(toolOutputSettle(line)).toEqual(reason);
    expect(compactDynamicToolOutput(line)?.settle).toEqual(reason);
  });

  it("finds no outcome in other tools' results", () => {
    for (const output of [
      undefined,
      "Done",
      { content: [{ type: "text", text: "{}" }] },
      { settle: "x" },
    ])
      expect(toolOutputSettle(output)).toBeUndefined();
  });

  it("compact wire output keeps the outcome, so a projected row can show it", () => {
    expect(compactDynamicToolOutput({ content: [{ type: "text", text: summary }] })).toEqual({
      settle: expected,
    });
  });
});

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by GOAT summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("reads goat call's printed envelope: ids and pages from ok values, failure from errors", () => {
    const htmlRender = { attachmentId: "attachment-1", title: "Report", height: 400 };
    const ok = JSON.stringify({
      status: "ok",
      value: { threadId: "thread-1", taskId: "task-1", htmlRender, response: "Private body" },
      meta: { host: "box" },
    });
    expect(compactDynamicToolOutput(ok)).toMatchObject({ threadId: "thread-1", taskId: "task-1" });
    expect(compactDynamicToolOutput(ok)).not.toHaveProperty("isError");
    expect(htmlRenderFromToolItem({ toolName: "goat.html_render", output: ok })).toEqual(
      compactDynamicToolOutput({ htmlRender })?.htmlRender,
    );

    const error = JSON.stringify({
      status: "error",
      error: {
        code: "not_found",
        reason: "thread_not_found",
        message: "Private",
        retryable: false,
      },
    });
    expect(compactDynamicToolOutput(error)).toEqual({ isError: true });
    // A tool's own value that merely has status "ok" keeps its other fields.
    expect(compactDynamicToolOutput({ status: "ok", value: 1, threadId: "thread-2" })).toEqual({
      threadId: "thread-2",
    });
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });
});

describe("mcpToolResultOutput", () => {
  const screenshot = { type: "image", mimeType: "image/png", data: "AAAA" };
  const structuredContent = { threadId: "thread-1", app: "Finder" };

  it("keeps a screenshot that only content carries, and readers still find the structured data", () => {
    const output = mcpToolResultOutput({
      content: [{ type: "text", text: "Finder" }, screenshot],
      structuredContent,
    });
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(compactDynamicToolOutput(output)).toEqual({ threadId: "thread-1" });
    expect(JSON.stringify(omitToolOutputImageData(output))).not.toContain("AAAA");
  });

  it("stores only the structured output when content has no image", () => {
    expect(
      mcpToolResultOutput({ content: [{ type: "text", text: "{}" }], structuredContent }),
    ).toBe(structuredContent);
    expect(mcpToolResultOutput({ content: [screenshot], structuredContent: null })).toEqual([
      screenshot,
    ]);
  });
});

describe("imageBlockFromDataUrl", () => {
  it("reads base64 raster data URLs and refuses everything else", () => {
    expect(imageBlockFromDataUrl("data:image/png;base64,AAAA")).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    });
    expect(imageBlockFromDataUrl("data:image/svg+xml;base64,AAAA")).toBeUndefined();
    expect(imageBlockFromDataUrl("data:image/png,raw")).toBeUndefined();
    expect(imageBlockFromDataUrl("https://example.com/a.png")).toBeUndefined();
  });
});

describe("mcpToolResultWithRawImages", () => {
  // Claude reports an MCP result with structured output as its text and that output.
  const claudeResult = { content: "Finder", structuredContent: { app: "Finder" } };
  const rawContent = [
    { type: "text", text: "Finder" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ];

  it("regression: brings back the screenshot only the raw tool result kept", () => {
    const output = mcpToolResultWithRawImages(claudeResult, rawContent);
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(output).toMatchObject({ structuredContent: { app: "Finder" } });
  });

  it("leaves a result alone when the raw result has no image", () => {
    expect(mcpToolResultWithRawImages(claudeResult, [{ type: "text", text: "Finder" }])).toBe(
      claudeResult,
    );
  });
});

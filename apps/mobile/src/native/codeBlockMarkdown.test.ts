import { describe, expect, it } from "vite-plus/test";

import {
  codeFenceRenderer,
  fencedCodeMarkdown,
  MAX_CHAT_HIGHLIGHT_CHARACTERS,
  fenceHighlightable,
  openFenceCode,
  streamingFenceCode,
} from "./codeBlockMarkdown";

describe("fencedCodeMarkdown", () => {
  it.each([
    ["a plain fence", "fun main() {}", "kotlin", "```kotlin\nfun main() {}\n```"],
    ["a longer fence than the code's", "```\nx\n```", "md", "````md\n```\nx\n```\n````"],
    ["no language", "x", "", "```\nx\n```"],
  ])("writes %s", (_, code, language, expected) => {
    expect(fencedCodeMarkdown(code, language)).toBe(expected);
  });
});

describe("codeFenceRenderer", () => {
  it.each([
    ["mermaid", true, { kind: "mermaid" }],
    ["math", true, { kind: "math" }],
    ["math", false, { kind: "native" }],
    ["kotlin", true, { kind: "highlight", language: "kotlin" }],
    ["KOTLIN", true, { kind: "highlight", language: "kotlin" }],
    ["diff", true, { kind: "highlight", language: "diff" }],
    ["ts", true, { kind: "native" }],
    ["python", true, { kind: "native" }],
    ["", true, { kind: "native" }],
    ["text", true, { kind: "native" }],
  ])("draws %j with math rendering %s as %j", (fence, mathRenderingEnabled, expected) => {
    expect(codeFenceRenderer(fence, mathRenderingEnabled)).toEqual(expected);
  });
});

describe("fenceHighlightable", () => {
  const fence = "~~~";

  it("waits while the message still leaves the fence open", () => {
    const code = "fun main() {\n  println(1)";
    const streaming = `Here:\n\n${fence}kotlin\n${code}`;
    expect(fenceHighlightable(code, openFenceCode(streaming))).toBe(false);
    expect(fenceHighlightable(code, openFenceCode(`${streaming}\n${fence}\n`))).toBe(true);
  });

  it("keeps a finished fence over the size bound plain", () => {
    const small = "val x = 1\n".repeat(10);
    const large = "val x = 1\n".repeat(MAX_CHAT_HIGHLIGHT_CHARACTERS / 10 + 1);
    expect(fenceHighlightable(small, openFenceCode(`${fence}kotlin\n${small}${fence}`))).toBe(true);
    expect(fenceHighlightable(large, openFenceCode(`${fence}kotlin\n${large}${fence}`))).toBe(
      false,
    );
  });

  it("colours a finished message's last fence even when the message never closed it", () => {
    // A stopped or cut turn ends inside its fence; only a message still streaming waits.
    const code = "fun main() {\n  println(1)";
    const markdown = `Here:\n\n${fence}kotlin\n${code}`;
    expect(fenceHighlightable(code, streamingFenceCode(markdown, true))).toBe(false);
    expect(fenceHighlightable(code, streamingFenceCode(markdown, false))).toBe(true);
  });
});

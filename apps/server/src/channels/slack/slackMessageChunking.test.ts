import { describe, expect, it } from "vite-plus/test";

import { chunkFenceAware } from "./slackMessageChunking.ts";

/** Every line that is not a fence line, in order: what a reader sees across the chunks. */
const contentLines = (text: string) =>
  text.split("\n").filter((line) => line !== "" && !/^`{3,}[\w-]*$/.test(line));
const withoutAddedFences = (chunks: ReadonlyArray<string>) => contentLines(chunks.join("\n"));

describe("chunkFenceAware", () => {
  it("keeps short text whole and splits prose at line breaks without losing any", () => {
    expect(chunkFenceAware("hello", 100)).toEqual(["hello"]);
    const text = Array.from({ length: 50 }, (_, index) => "문장 " + index).join("\n");
    const chunks = chunkFenceAware(text, 60);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      expect(chunk.endsWith("\n") || chunk === chunks.at(-1)).toBe(true);
    }
  });

  it("never cuts an emoji in half", () => {
    const text = "🐐".repeat(40);
    const chunks = chunkFenceAware(text, 7);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it("closes and reopens a code block, with its language, across chunks", () => {
    const code = Array.from({ length: 30 }, (_, index) => "let a" + index + " = 1;").join("\n");
    const text = "Before\n```ts\n" + code + "\n```\nAfter";
    const chunks = chunkFenceAware(text, 80);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```ts\n")).toBe(true);
    expect(withoutAddedFences(chunks)).toEqual(contentLines(text));
  });

  it("treats backticks inside a code line as content, not a closing fence", () => {
    const lines = Array.from({ length: 20 }, (_, index) => "const m" + index + ' = "```";');
    const text = "```js\n" + lines.join("\n") + "\n```";
    const chunks = chunkFenceAware(text, 70);
    for (const chunk of chunks) expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(withoutAddedFences(chunks)).toEqual(contentLines(text));
  });

  it("reopens a longer fence with the same run of backticks", () => {
    const text = "````md\n" + "x\n".repeat(60) + "````";
    const chunks = chunkFenceAware(text, 40);
    expect(chunks[1]!.startsWith("````md\n")).toBe(true);
    expect(withoutAddedFences(chunks)).toEqual(contentLines(text));
  });
});

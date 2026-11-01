import { describe, expect, it } from "vite-plus/test";

import { hasGoatBotMarkdown, splitGoatBotTextLinks } from "./links.ts";

const links = (text: string) =>
  splitGoatBotTextLinks(text).flatMap((part) => (part.kind === "link" ? [part.url] : []));

describe("splitGoatBotTextLinks", () => {
  it("keeps every character and links each address", () => {
    const text = "Stars: 17.8k\nURL:https://github.com/example/opencodex and http://a.dev/x";
    const parts = splitGoatBotTextLinks(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(links(text)).toEqual(["https://github.com/example/opencodex", "http://a.dev/x"]);
    expect(parts[0]).toEqual({ kind: "text", text: "Stars: 17.8k\nURL:" });
  });

  it("leaves sentence punctuation and unopened brackets outside the link", () => {
    expect(links("See https://a.dev/x.")).toEqual(["https://a.dev/x"]);
    expect(links("(see https://a.dev/x)")).toEqual(["https://a.dev/x"]);
    expect(links("https://en.wikipedia.org/wiki/Goat_(film), then")).toEqual([
      "https://en.wikipedia.org/wiki/Goat_(film)",
    ]);
    expect(links("주소는 https://a.dev/x。")).toEqual(["https://a.dev/x"]);
  });

  it("returns plain text when there is no address", () => {
    expect(splitGoatBotTextLinks("no links here")).toEqual([
      { kind: "text", text: "no links here" },
    ]);
  });
});

describe("hasGoatBotMarkdown", () => {
  it.each([
    "운영체제는 **Windows 11 Pro (빌드 26200)**이며",
    "*italic*",
    "snake_case",
    "`code`",
    "[link](https://a.dev)",
    "<https://a.dev>",
    "user@example.com",
    "WWW.example.com",
    "HTTPS://example.com",
    "Tom &amp; Jerry",
    "a \\ b",
    "$x$",
    "a | b",
    "# Title",
    "> quote",
    "- item",
    "+ item",
    "1. item",
    "2) item",
    "Title\n===",
    "Title\n---",
    "    indented code",
    "\tcode",
    " \tcode",
    "   \tcode",
  ])("routes %j through the Markdown renderer", (text) => {
    expect(hasGoatBotMarkdown(text)).toBe(true);
  });

  it.each([
    "이 컴퓨터의 CPU 코어 수를 알려드릴게요.",
    "Stars: 17.8k\nURL: https://github.com/example/opencodex",
    "Done on 2026-10-29 at 18:45, 3 of 4 checks passed.",
    "Line one  \nline two",
    "First paragraph.\n\nSecond paragraph.",
  ])("keeps %j as plain text", (text) => {
    expect(hasGoatBotMarkdown(text)).toBe(false);
  });
});

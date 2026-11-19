import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  remarkAssistantInsights,
} from "@goat/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownBlocks } from "./markdownStreamBlocks";
import { rehypeHeadingIds } from "./markdownFragments";

// Whitespace between top-level blocks collapses in the rendered message.
const html = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkAssistantInsights, ...CHAT_MARKDOWN_REMARK_PLUGINS]}
      rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
    >
      {source}
    </ReactMarkdown>,
  )
    .replace(/>\s+</g, "><")
    .trim();

describe("splitMarkdownBlocks", () => {
  it("keeps repeated heading ids correct at every streamed prefix", () => {
    const text = "# Setup\n\n# Setup\n\n[Second](#setup-1)";
    const rendered = (source: string) =>
      renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={[...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds]}
        >
          {source}
        </ReactMarkdown>,
      )
        .replace(/>\s+</g, "><")
        .trim();
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source) ?? [source];
      expect(blocks.map(rendered).join("")).toBe(rendered(source));
    }
    expect(splitMarkdownBlocks(text)).toBeNull();
    expect(splitMarkdownBlocks("# First\n\n# Second\n\nordinary text")).toEqual([
      "# First\n\n",
      "# Second\n\n",
      "ordinary text",
    ]);
  });
  it.each([
    "## /home/a/b.ts\n\n## home/a/b.ts",
    "## see https://x.com/a\n\n## see httpsxcoma",
    "## Done:\n\n## Done",
    "## a ` x ` b\n\n## a x b",
    "# Setup\n\n# $$ Setup $$\n\n[second](#setup-1)",
    "\ufeff# Setup\n\n# Setup\n\n[second](#setup-1)",
    "> Setup\n> ===\n\n> Setup\n> ===",
    "# onetwo\n\none\ntwo\n===",
    "# Setup\n\n# &#83;etup\n\n[second](#setup-1)",
    "# Setup\n\npara\n\n- a\n\n  ```\n  b\nx\n\nSetup\n===\n",
    "Setup\n===\n\n> ## **Setup**\n\n- # [Setup](https://example.com)\n\n```sh\n# Setup\n```",
  ])("preserves heading ids and math rendering across streamed prefixes: %s", (text) => {
    const rendered = (source: string) =>
      renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={[
            remarkAssistantInsights,
            [remarkMath, { singleDollarTextMath: true }],
            ...CHAT_MARKDOWN_REMARK_PLUGINS,
          ]}
          rehypePlugins={[...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeHeadingIds]}
        >
          {source}
        </ReactMarkdown>,
      )
        .replace(/>\s+</g, "><")
        .trim();
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      expect((splitMarkdownBlocks(source) ?? [source]).map(rendered).join("")).toBe(
        rendered(source),
      );
    }
  });
  it.each(["Step 1: Install", "Done:", "apps/web", "Fix (web)", "What's next?"])(
    "keeps splitting headings with prose punctuation: %s",
    (heading) => {
      expect(splitMarkdownBlocks(`## ${heading}\n\nNext paragraph.`)).toEqual([
        `## ${heading}\n\n`,
        "Next paragraph.",
      ]);
    },
  );
  it.each(["Setup\n===\n\nNext", "# Setup\n\n# `Setup`"])(
    "uses whole-document rendering for ambiguous headings: %s",
    (source) => {
      expect(splitMarkdownBlocks(source)).toBeNull();
    },
  );
  it("renders a line-leading inline backtick span at each streamed prefix", () => {
    const text = "```a``` is inline.\n\nprose\n\n```\none\n\ntwo\n```\n\nafter";
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.join("")).toBe(source);
      expect(blocks!.map(html).join("")).toBe(html(source));
    }
  });
  it.each([
    "# Title\n\nFirst paragraph with `code` and **bold**.\n\nSecond [link](https://example.com).",
    "- one\n- two\n\n- loose three\n\n  continued\n\nAfter the list.",
    "1. first\n\n2. second\n\nText\n\n3) restarted",
    "```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nend",
    "> quote\n\n> another quote\n\n> [!NOTE]\n> alert",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.",
    "para\n\n    indented code\n\nnext",
    "Setext\n===\n\nnext\n---\n\n- [ ] task\n- [x] done",
    "- a\n\n  ```\n  x\n\n```\n\nb",
    "- a\n\n  ```\n  x\n\ny\n\n  ```\n\nb",
    "intro\n\n★ Insight ─────\nfirst\n\n```\n─────\n```\n\n- point\n─────\n\nafter\n\n`★ Insight ─────`\nsecond\n`─────`\n\nend",
  ])("renders each block as the whole text renders it, at every streamed prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source) ?? [source];
      expect(blocks.join("")).toBe(source);
      expect(blocks.map(html).join("")).toBe(html(source));
    }
  });

  it("splits only between closed blocks", () => {
    expect(splitMarkdownBlocks("a\n\n```\nb\n\nc\n```\n\n- d\n\n- e\n\nf")).toEqual([
      "a\n\n",
      "```\nb\n\nc\n```\n\n- d\n\n- e\n\n",
      "f",
    ]);
  });

  it("renders a blockquote definition correctly at every streamed prefix", () => {
    const text = "See [x]\n\n> [x]: https://example.com";
    for (let end = 0; end <= text.length; end++) {
      const source = text.slice(0, end);
      const blocks = splitMarkdownBlocks(source);
      expect(blocks?.map(html).join("") ?? html(source)).toBe(html(source));
    }
  });

  it.each([
    "[ref]\n\n[ref]: /later",
    "See [x]\n\n> [x]: https://example.com",
    "See [x]\n\n> > [x]: /a",
    "See [x]\n\n- [x]: /a",
    "See [x]\n\n1. item\n\n   [x]: /a",
    "- a\n  - b\n\n    [x]: /a\n\nSee [x]",
    "See [x]\n\n> - [x]: /a",
    "See [a b]\n\n> [a\n> b]: /a",
    "See [a\\]b]\n\n> [a\\]b]: /a",
    "a[^x]\n\n[^x]: note",
    "<details>\n\nbody\n\n</details>",
    ":::note\n\ncontent\n\n:::",
    "$$\na\n\nb\n$$",
    "a\r\n\r\nb",
  ])("keeps text with document-wide syntax whole: %j", (text) => {
    expect(splitMarkdownBlocks(text)).toBeNull();
  });
});

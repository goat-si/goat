import { describe, expect, it } from "vite-plus/test";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import {
  markdownForNativeParsing,
  markdownForNativeRendering,
  markdownWithFileEmbeds,
  markdownWithInlineFileLinks,
  markdownWithTableBreaks,
} from "./markdownDocument";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";

type NativeNode = Awaited<ReturnType<typeof parseMarkdown>>;

// The flags EnrichedMarkdownText passes on mobile.
const MOBILE_FLAGS = { latexMath: true, admonitions: true, preserveWindowsPaths: true };

function inline(node: NativeNode): string {
  const children = (node.children ?? []).map(inline).join("");
  switch (node.type) {
    case "Text":
      return (node.content ?? "").replaceAll("\u2060", "");
    case "Strong":
      return `<b>${children}</b>`;
    case "Emphasis":
      return `<i>${children}</i>`;
    case "Link":
      return `<a ${node.attributes?.url ?? ""}>${children}</a>`;
    case "LatexMathInline":
      return `$${node.content ?? children}$`;
    default:
      return node.content ?? children;
  }
}

async function rendered(markdown: string) {
  return inline(
    await parseMarkdown(
      markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX),
      MOBILE_FLAGS,
    ),
  );
}

describe("CJK emphasis in native Markdown", () => {
  it.each([
    ["**한글(강조)**입니다", "<b>한글(강조)</b>입니다"],
    ["**한국어.**입니다", "<b>한국어.</b>입니다"],
    ["**「推しの子」**の", "<b>「推しの子」</b>の"],
    ["**中文（强调）**是", "<b>中文（强调）</b>是"],
    ["한국어**(강조)**입니다", "한국어<b>(강조)</b>입니다"],
    ["***한글(강조)***입니다", "<i><b>한글(강조)</b></i>입니다"],
    ["**가(나)**다**라(마)**바", "<b>가(나)</b>다<b>라(마)</b>바"],
    ["*이것은 **한글(강조)**입니다*", "<i>이것은 <b>한글(강조)</b>입니다</i>"],
    ["값 $x$ 는 **한국어.**입니다", "값 $x$ 는 <b>한국어.</b>입니다"],
    ["C:\\src\\app.ts 와 **한국어.**입니다", "C:\\src\\app.ts 와 <b>한국어.</b>입니다"],
  ])("closes emphasis the way web does: %s", async (markdown, expected) => {
    expect(await rendered(markdown)).toBe(expected);
    const once = markdownForNativeParsing(markdown);
    expect(markdownForNativeParsing(once)).toBe(once);
  });

  it.each([
    "**bold.**text",
    "**Note:** done",
    "**한국어**입니다",
    "__한글(강조)__입니다",
    "`**한글(강조)**입니다`",
    // A repair here could change how the native parser pairs other marks, so they keep today's rendering.
    "*한글(강조)**입니다*",
    "*한(a)***다*",
    "[*한글(강조)**입니다*](https://example.com)",
    "**한글(강조)**입니다 https://example.com",
    "[*http://a.com/*다**",
    "**한.**다**",
    "*가.*a.***나***다",
    "C:\\src\\file*.ts 와 **한국어.**입니다",
    "$**한글(강조)**입니다$",
    "\\$$**한국어.**입니다$",
    "\\$$$**한국어.**입니다$$",
    "**$x$**입니다",
    "한국어**(가 $x** 입니다$",
    "*$x* **한국어.**입니다 $",
    "**||한글.**입니다||",
    "**~~한글.**입니다~~",
  ])("leaves Markdown it does not repair byte for byte: %s", (markdown) => {
    expect(markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX)).toBe(markdown);
  });

  it("repairs emphasis inside a table cell and keeps the table", async () => {
    const document = await parseMarkdown(
      markdownForNativeRendering(
        "| 열 |\n| --- |\n| **한글(강조)**입니다 |",
        ENRICHED_INLINE_FILE_LINK_REGEX,
      ),
      MOBILE_FLAGS,
    );
    expect(document.children?.[0]?.type).toBe("Table");
    expect(inline(document)).toContain("<b>한글(강조)</b>입니다");
  });

  it("repairs emphasis on the file embed path", async () => {
    const content = markdownWithInlineFileLinks(
      markdownForNativeParsing("**한글(강조)**입니다 `src/app.ts`\n\n![화면](images/screen.png)"),
      ENRICHED_INLINE_FILE_LINK_REGEX,
    );
    const { markdown } = markdownWithFileEmbeds(content, () => "screen.png");
    expect(inline(await parseMarkdown(markdownWithTableBreaks(markdown), MOBILE_FLAGS))).toContain(
      "<b>한글(강조)</b>입니다 <a src/app.ts>src/app.ts</a>",
    );
  });
});

it("renders a user's typed indentation as spaces and tabs without changing list or code structure", async () => {
  const source = [
    "   Plan",
    "   **Step**",
    "\tDetail",
    "",
    "- item",
    "    more",
    "",
    "    ```txt",
    "    code",
    "    ```",
  ].join("\n");
  const renderUser = async (preserveIndentation: boolean) =>
    parseMarkdown(
      markdownForNativeRendering(source, ENRICHED_INLINE_FILE_LINK_REGEX, preserveIndentation),
      { ...MOBILE_FLAGS, hardSoftBreaks: true },
    );
  const user = await renderUser(true);
  const assistant = await renderUser(false);
  expect(inline(user)).toContain("   Plan");
  expect(inline(user)).toContain("<b>Step</b>");
  expect(inline(user)).toContain("\tDetail");
  expect(inline(user)).toContain("  more");
  expect(user.children?.map((node) => node.type)).toEqual(
    assistant.children?.map((node) => node.type),
  );
  expect(inline(user.children![1]!)).toContain("code");
  expect(inline(assistant)).not.toContain("   Plan");
});

it.each([
  "Plan\n $x +\n    y$",
  "Plan \\(\n$x +\n    y$",
  "Plan\n $x \\(a\\) +\n    y$",
  "Plan\n $$x + \\text{`$z$`}\n    + y$$",
  "Plan\n   `one\n    two`",
])("leaves native math and code blocks unchanged: %s", async (source) => {
  const flags = { ...MOBILE_FLAGS, hardSoftBreaks: true };
  const baseline = markdownForNativeRendering(source, ENRICHED_INLINE_FILE_LINK_REGEX);
  const restored = markdownForNativeRendering(source, ENRICHED_INLINE_FILE_LINK_REGEX, true);
  expect(await parseMarkdown(restored, flags)).toEqual(await parseMarkdown(baseline, flags));
  expect(restored).toBe(baseline);
});

it.each([
  "Plan\n https://example.com.",
  "Plan\n www.example.com.",
  "Plan\n person@example.com.",
  "Plan\n ftp://example.com/path.",
  "Plan\n https://example.com/a?b=1&c=2.",
  "Plan\n ftp://example.com/path(x(y))",
  "Plan\n~~Continue at\n  ftp://example.com/path~~",
  "Plan\n   **Step**",
  "Plan\n   ~~Step~~",
])("leaves native links and formatting unchanged: %s", async (source) => {
  const flags = { ...MOBILE_FLAGS, hardSoftBreaks: true };
  const baseline = markdownForNativeRendering(source, ENRICHED_INLINE_FILE_LINK_REGEX);
  const restored = markdownForNativeRendering(source, ENRICHED_INLINE_FILE_LINK_REGEX, true);
  expect(await parseMarkdown(restored, flags)).toEqual(await parseMarkdown(baseline, flags));
  expect(restored).toBe(baseline);
});

describe("a leading byte-order mark", () => {
  const BOM = "\uFEFF";
  const render = (markdown: string) =>
    markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);
  const embed = (markdown: string) =>
    markdownWithFileEmbeds(markdown, (href) => (href.endsWith(".pdf") ? "report.pdf" : null))
      .markdown;

  it.each([
    ["HTML links", render, 'Hello <a href="https://example.com">world</a>!'],
    ["HTML link labels", render, '<a href="https://example.com">a[b]</a>'],
    ["HTML links after a bang", render, '!<a href="https://example.com">world</a>'],
    ["inline file links", render, "See `src/app.ts` now"],
    ["prose file paths", render, "See /tmp/notes.md"],
    ["table breaks", render, "Intro\n| a | b |\n| - | - |\n| 1 | 2 |"],
    ["Windows path destinations", render, "Open [app](C:\\work\\app.ts) now"],
    ["angled Windows path destinations", render, "Open [app](<C:\\work\\app.ts>) now"],
    ["image paragraphs", render, "Caption\n![shot](https://example.com/a.png)"],
    ["file embeds", embed, "See ![doc](files/report.pdf) now"],
  ])("leaves %s where they are", (_name, transform, markdown) => {
    expect(transform(markdown)).not.toBe(markdown);
    expect(transform(`${BOM}${markdown}`)).toBe(`${BOM}${transform(markdown)}`);
  });

  it("is kept when the rewrite ends in a second table-break pass", () => {
    const markdown = "Intro text\n| a | c |\n|---|---|\n| `./a\\|b.ts` | b |";
    expect(render(markdown)).toBe(
      "Intro text\n\n| a | c |\n|---|---|\n| [./a|b.ts](<./a|b.ts>) | b |",
    );
    expect(render(`${BOM}${markdown}`)).toBe(`${BOM}${render(markdown)}`);
  });
});

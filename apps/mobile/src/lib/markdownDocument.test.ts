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

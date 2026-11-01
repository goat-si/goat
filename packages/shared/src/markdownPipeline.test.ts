import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/environment/thread)\n\n<a href="javascript:alert(1)">Unsafe</a>', // goat-rename: legacy
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/environment/thread" }, // goat-rename: legacy
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

// goat-rename: legacy-begin
it.each(["t3-thread", "goat-thread", "t3-context", "goat-context", "t3-citation", "goat-citation"])(
  "preserves %s links through the Markdown sanitizer",
  (scheme) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
    const href = `${scheme}://v1/thread`;
    const tree = processor.runSync(processor.parse(`[reference](${href})`));
    expect(tree.children[0]).toMatchObject({ children: [{ properties: { href } }] });
  },
);
// goat-rename: legacy-end

it("builds the tree rehype-raw builds for markdown without HTML", () => {
  type Node = {
    type: string;
    tagName?: string;
    value?: string;
    position?: unknown;
    data?: unknown;
    children?: Node[];
  };
  // What the round trip changes that renders the same; see `needsHtmlParser`.
  const comparable = (node: Node): Node => {
    const { position, children, data, ...rest } = node;
    const result: Node =
      node.type === "text" || node.type === "root" ? rest : { ...rest, position, data };
    if (!children) return result;
    const merged: Node[] = [];
    for (const child of children.map(comparable)) {
      const last = merged.at(-1);
      if (child.type === "text" && last?.type === "text") last.value += child.value ?? "";
      else merged.push(child);
    }
    // Blank text inside a table moves in front of it; the JSX runtime drops it in tables.
    const inTable = /^(?:table|thead|tbody|tfoot|tr)$/.test(node.tagName ?? "");
    result.children = merged.filter(
      (child, index) =>
        child.type !== "text" ||
        child.value?.trim() ||
        !(inTable || merged[index + 1]?.tagName === "table"),
    );
    return result;
  };
  const tree = (rehypePlugins: typeof CHAT_MARKDOWN_REHYPE_PLUGINS, markdown: string) => {
    const processor = unified()
      .use(remarkParse)
      .use(CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypePlugins);
    return comparable(processor.runSync(processor.parse(markdown)) as Node);
  };
  const [first, , ...rest] = CHAT_MARKDOWN_REHYPE_PLUGINS;
  const withRaw = [first!, rehypeRaw, ...rest];
  for (const markdown of [
    "- [ ] open\n- [x] done\n\nNote[^1]\n\n[^1]: The note.",
    "| a | b |\n| :- | -: |\n| `c` | ![d](./d.png) |\n\n```ts title=x\nconst a = 1;\n```",
    // The HTML parser moves the footnote's link out of the label's link.
    "[note[^x]](https://example.com)\n\n[^x]: text",
    "**a** **b**\r\n> - | a |\r\n>   | - |\r\n>   | b |\r\n\n-\tx\n\n  y",
  ]) {
    expect(tree(CHAT_MARKDOWN_REHYPE_PLUGINS, markdown)).toEqual(tree(withRaw, markdown));
  }
});

it("keeps backslashes that CommonMark would read as escapes in prose Windows paths", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const text = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "code"
        ? `<code>${(node.children ?? []).map(text).join("")}</code>`
        : (node.children ?? []).map(text).join("");
  const render = (markdown: string) => text(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
  ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
  expect(render(String.raw`Escaped C:\\Users\\me`)).toBe(String.raw`Escaped C:\\Users\\me`);
  expect(render(String.raw`See C:\x and \*this\* and Note:\*that\*.`)).toBe(
    String.raw`See C:\x and *this* and Note:*that*.`,
  );
  expect(render(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`)).toBe(
    String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
  );
});

it("keeps an image on its own line under a label but leaves inline images inline", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "br" || node.tagName === "img"
        ? `<${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  const render = (markdown: string) => shape(processor.runSync(processor.parse(markdown)) as Node);

  expect(
    render("**Palette**\n![Palette](/tmp/palette.png)\n**Hero** (dark)\n![Hero](/tmp/hero.png)"),
  ).toBe("Palette<br>\n<img><br>\nHero (dark)<br>\n<img>");
  expect(render("Built [![CI](/ci.svg)](/ci)\nand wrapped")).toBe("Built <img>\nand wrapped");
  expect(render("Hard-wrapped\nprose")).toBe("Hard-wrapped\nprose");
});

function renderEmphasis(markdown: string, math = false) {
  const processor = unified()
    .use(remarkParse)
    .use(math ? [[remarkMath, { singleDollarTextMath: true }]] : [])
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
  const shape = (node: Node): string =>
    node.type === "text"
      ? (node.value ?? "")
      : node.tagName === "strong" || node.tagName === "em" || node.tagName === "code"
        ? `<${node.tagName}>${(node.children ?? []).map(shape).join("")}</${node.tagName}>`
        : (node.children ?? []).map(shape).join("");
  return shape(processor.runSync(processor.parse(markdown)) as Node);
}

it("closes CJK strong emphasis that ends in punctuation right before the next word", () => {
  const render = (markdown: string) => renderEmphasis(markdown);
  expect(
    render("운영체제는 **Windows 11 Pro, 버전 10.0.26200 (빌드 26200)**이며, 확인했습니다."),
  ).toBe(
    "운영체제는 <strong>Windows 11 Pro, 버전 10.0.26200 (빌드 26200)</strong>이며, 확인했습니다.",
  );
  expect(render("これは**「重要」**です。*（注）*を読む。")).toBe(
    "これは<strong>「重要」</strong>です。<em>（注）</em>を読む。",
  );
  expect(render("这是**“重点”**内容。")).toBe("这是<strong>“重点”</strong>内容。");
  expect(renderEmphasis("값은 $x_1$이고 **결과 (최종)**입니다.", true)).toBe(
    "값은 <code>x_1</code>이고 <strong>결과 (최종)</strong>입니다.",
  );
});

it("keeps CommonMark emphasis rules for English text", () => {
  expect(renderEmphasis('**bold** and a**"quoted"**b and snake_case_name and 2*3*4')).toBe(
    '<strong>bold</strong> and a**"quoted"**b and snake_case_name and 2<em>3</em>4',
  );
});

import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REHYPE_PLUGINS } from "./markdownPipeline.ts";

it("keeps raw and percent-encoded Windows drive file links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  type Node = { tagName?: string; properties?: { href?: string }; children?: Node[] };
  const hrefs = (node: Node): Array<string | undefined> => [
    ...(node.tagName === "a" ? [node.properties?.href] : []),
    ...(node.children ?? []).flatMap(hrefs),
  ];
  const tree = processor.runSync(
    processor.parse(
      [
        "[report.md](<C:%5CUsers%5Ctest%5Creport.md#L7>)",
        "[lower](c:%5cUsers/test%5creport.md)",
        "[raw](C:\\Users\\test\\report.md)",
        "[ref][win]",
        "",
        "[win]: <D:%5Cwork%5Creport.md#L12>",
      ].join("\n"),
    ),
  ) as Node;
  expect(hrefs(tree)).toEqual([
    "file:///C:/Users/test/report.md#L7",
    "file:///c:/Users/test/report.md",
    "file:///C:/Users/test/report.md",
    "file:///D:/work/report.md#L12",
  ]);
});

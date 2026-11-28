import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

it.each([
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const)("links paths in over-indented lists (%s)", (_, plugins) => {
  const processor = unified().use(remarkParse).use(plugins);
  const links = (markdown: string) => {
    const urls: string[] = [];
    const visit = (node: Root | RootContent) => {
      if (node.type === "link") urls.push(node.url);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(processor.runSync(processor.parse(markdown), markdown) as Root);
    return urls;
  };
  expect(links("-       /Users/me/app.ts:42")).toEqual(["/Users/me/app.ts:42"]);
  expect(links("-       `/Users/me/app.ts:42`")).toEqual([]);
  expect(links("    /Users/me/code.ts:42")).toEqual([]);
});

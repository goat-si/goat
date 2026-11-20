import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "./markdownPipeline.ts";

it.each([
  ["default", CHAT_MARKDOWN_REMARK_PLUGINS],
  ["with breaks", CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS],
] as const)(
  "ends bare URLs at Arabic punctuation while preserving source positions and explicit links (%s)",
  (_, plugins) => {
    const processor = unified().use(remarkParse).use(plugins);
    const url = "https://example.com/a";
    const boundary = { line: 1, column: url.length + 1, offset: url.length };
    for (const punctuation of ["،", "؛", "؟", "۔"]) {
      const markdown = `${url}${punctuation}بعد`;
      expect(processor.runSync(processor.parse(markdown), markdown)).toMatchObject({
        children: [
          {
            children: [
              { type: "link", url, position: { end: boundary } },
              { type: "text", value: `${punctuation}بعد`, position: { start: boundary } },
            ],
          },
        ],
      });
    }
    const explicit = "[label](https://example.com/a،b)";
    expect(processor.runSync(processor.parse(explicit), explicit)).toMatchObject({
      children: [{ children: [{ type: "link", url: "https://example.com/a،b" }] }],
    });
  },
);

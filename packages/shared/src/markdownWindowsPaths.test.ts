import { expect, it, vi } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

import { remarkKeepWindowsPaths, remarkKeepWindowsProsePaths } from "./markdownWindowsPaths.ts";

const plugins = [
  ["paths and destinations", remarkKeepWindowsPaths],
  ["prose paths", remarkKeepWindowsProsePaths],
] as const;

// GFM task items remove their "[ ] " marker from a text node the escape scan already saw.
it.each(plugins)("%s keeps drive-path escapes in GFM task list items", (_, plugin) => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(plugin);
  const markdown = [
    "- [ ] long words before the path then C:\\Temp\\out.txt",
    "- [x] D:\\a\\b and a\\_b",
  ].join("\n");
  const texts: string[] = [];
  const visit = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === "text" && node.value !== undefined) texts.push(node.value);
    for (const child of (node.children ?? []) as (typeof node)[]) visit(child);
  };
  visit(processor.runSync(processor.parse(markdown)) as never);
  expect(texts).toEqual(["long words before the path then C:\\Temp\\out.txt", "D:\\a\\b and a_b"]);
});

it.each(plugins)("%s limits drive-path checks to the word containing each escape", (_, plugin) => {
  const processor = unified().use(remarkParse).use(plugin);
  const identifiers = Array.from({ length: 200 }, (_, index) => `metric_name_${index}`);
  const markdown = `Supported metrics: ${identifiers.map((name) => name.replaceAll("_", "\\_")).join(", ")}.`;
  const pattern = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/.source;
  const test = RegExp.prototype.test;
  let inspectedCharacters = 0;
  using _test = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
    this: RegExp,
    value: string,
  ) {
    if (this.source === pattern) inspectedCharacters += value.length;
    return test.call(this, value);
  });

  expect(processor.parse(markdown)).toMatchObject({
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: `Supported metrics: ${identifiers.join(", ")}.` }],
      },
    ],
  });
  expect(inspectedCharacters).toBeGreaterThan(0);
  expect(inspectedCharacters).toBeLessThan(markdown.length * 2);
});

it.each(plugins)(
  "%s preserves prose paths and ordinary escapes across whitespace boundaries",
  (_, plugin) => {
    const processor = unified().use(remarkParse).use(plugin);
    for (const whitespace of [" ", "\t", "\u00a0", "\u2003", "\u202f", "\ufeff"]) {
      const markdown = String.raw`Before${whitespace}C:\Users\me\_build${whitespace}\*literal\*`;
      expect(processor.parse(markdown)).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: String.raw`Before${whitespace}C:\Users\me\_build${whitespace}*literal*`,
              },
            ],
          },
        ],
      });
    }
  },
);

it.each(plugins)("%s finds each escape's word after earlier escapes in the text", (_, plugin) => {
  const processor = unified().use(remarkParse).use(plugin);
  const markdown = String.raw`one\_two C:\a\_b \*x\* three\_four&#x20;D:\c\_d \*y\* *em*E:\e\_f \*z\*`;
  expect(processor.parse(markdown)).toMatchObject({
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: String.raw`one_two C:\a\_b *x* three_four D:\c\_d *y* ` },
          { type: "emphasis" },
          { type: "text", value: String.raw`E:\e\_f *z*` },
        ],
      },
    ],
  });
});

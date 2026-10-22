import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { noteMarkdownFixtures } from "./noteMarkdown.fixtures";
import { noteExtensions } from "./noteExtensions";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

const schema = getSchema(noteExtensions());
function parse(source: string) {
  const doc = schema.nodeFromJSON(noteMarkdownToDoc(source));
  doc.check();
  return doc;
}

// Exercise the serializer itself as well as the unchanged-source fast path.
function withoutSourceCache(node: JSONContent): JSONContent {
  const { noteSource: _source, noteFingerprint: _fingerprint, ...attrs } = node.attrs ?? {};
  return {
    ...node,
    attrs,
    ...(node.content ? { content: node.content.map(withoutSourceCache) } : {}),
  };
}

const listCode = [
  "-     [ ] literal\n",
  "- parent\n      - [ ] literal\n",
  "1. parent\n       - [ ] literal\n",
  "- parent\n - [ ] literal\n",
  "-\t[ ] literal\n",
  "- parent\n  -     [ ] literal\n",
];
const htmlBlocks = [
  "<pre>\n\n- [ ] literal\n\n</pre>\n",
  "   <PRE class=code>\n\n# literal\n```\n- [ ] literal\n</sCrIpT>\n",
  "<script>\n\n- [ ] literal\n</script>\n",
  "<style>\n\n- [ ] literal\n</style>\n",
  "<textarea>\n\n- [ ] literal\n</textarea>\n",
  "<!--\n# literal\n\n- [ ] literal\n\n-->\n",
  "<?target\n\n# literal\n- [ ] literal\n?>\n",
  "<!DOCTYPE\n\n# literal\n- [ ] literal\n>\n",
  "<![CDATA[\n\n# literal\n- [ ] literal\n]]>\n",
  "<div>\n# literal\n- [ ] literal\n```\n</div>\n",
  "</table>\n# literal\n- [ ] literal\n",
  "<search\n# literal\n- [ ] literal\n",
  '<custom-tag a="value > here" b=unquoted>\n# literal\n- [ ] literal\n',
  "</custom-tag>\n# literal\n- [ ] literal\n",
  "<pre>\n\n- [ ] literal\n",
  "<!--\n\n- [ ] literal\n",
];
const nonCanonical = [
  "* [ ] alternate bullet\n",
  "+ [ ] another bullet\n",
  "-  [ ] spaced marker\n",
  "- [X] uppercase check\n",
  "- [ ]  spaced task\n",
  "1) one\n2) two\n",
  "1. one\n1. two\n",
  "- parent\n   - [ ] offset child\n",
  "- [ ] __bold__\n",
  "- [ ] **~~`code`~~**\n",
  "- [ ] *~~`code`~~*\n",
  "- [ ] **~~*`code`*~~**\n",
  "- [ ] *~~**`code`**~~*\n",
  "- [ ] ***~~`code`~~***\n",
  "- [ ] parent\n  - [X] uppercase child\n",
  "> __bold__\n",
  "***\n",
  "~~~ts\ncode\n~~~\n",
];
const externalContainerFences = ["- parent", "> paragraph"].flatMap((container) =>
  ["", "\nlazy continuation"].flatMap((lazy) =>
    ["```", "~~~"].map((fence) => `${container}${lazy}\n ${fence}\n\n- [ ] literal\n\n ${fence}\n`),
  ),
);
const trickyMarkdown = [
  "10. parent\n   - [ ] literal\n",
  ...externalContainerFences,
  ...listCode,
  ...htmlBlocks,
  ...nonCanonical,
  "Title\n=====\n",
  "Subtitle\n---\n",
  "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
  "[reference][label]\n\n[label]: https://example.com\n",
  "Text[^note]\n\n[^note]: a footnote\n",
  "hard break  \nnext line\n",
  "hard break\\\nnext line\n",
  "> > nested quote\n> > - [ ] quoted literal\n",
  "# CRLF\r\n\r\n- [ ] literal CRLF\r\n",
  "- [ ] supported first\n- [x] supported second\n  - [ ] supported child\n",
  "- [ ] line with trailing spaces  \n- [ ] following task\n",
  "- [ ] line with backslash\\\n- [ ] following task\n",
];

function generatedDocuments(count: number): string[] {
  let seed = 0x7e57b07;
  function choose<T>(values: readonly T[]): T {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return values[(seed >>> 0) % values.length]!;
  }
  const fragments = [
    "paragraph",
    "paragraph\nlazy continuation",
    "# Heading",
    "Title\n=====",
    "---",
    "- [ ] {task}",
    "- [x] {task}\n- [ ] {task}",
    "- [ ] {task}\n  - [x] {task}",
    "- parent\n  - [ ] {task}",
    "1. parent\n   - [ ] {task}",
    "10. parent\n   - [ ] {task}",
    "* [ ] {task}",
    "- [X] {task}",
    "-  [ ] {task}",
    "- [ ]  {task}",
    "- [ ] **bold** {task}",
    "- [ ] `code` {task}",
    "- [ ] __bold__ {task}",
    "- [ ] {task}  \ncontinuation",
    "- parent\n      - [ ] {task}",
    "- p\n  ~~~",
    "- p\n  ```",
    "- p\n  ~~~\n> q",
    "- p\n  ```\n# Heading",
    "- p\nlazy continuation\n ```\n- [ ] {task}",
    "> quote",
    "> quote\nlazy continuation",
    "> - [ ] {task}",
    "> p\n ~~~\n- [ ] {task}",
    "```\n- [ ] {task}\n```",
    "~~~ts\n- [ ] {task}\n~~~",
    "```unclosed\n- [ ] {task}",
    " ```\n- [ ] {task}\n ```",
    "    - [ ] {task}",
    "| a | b |\n| --- | --- |\n| x | y |",
    "<pre>\n\n- [ ] {task}\n</pre>",
    "<pre>\n\n- [ ] {task}",
    "<!--\n- [ ] {task}\n-->",
    "<div>\n- [ ] {task}\n</div>",
    "<custom-tag>\n- [ ] {task}\n</custom-tag>",
    "[reference][label]\n\n[label]: /target",
    "Text[^note]\n\n[^note]: a footnote",
    "hard break  \nnext line",
    "Unicode 한글 🐐",
    "\\*literal\\* and ``code `tick` ``",
  ];
  return Array.from({ length: count }, (_, document) => {
    let task = 0;
    const label = () => `probe${document}x${task++}`;
    const parts = [`- [ ] ${label()}\n\n# Start\n`];
    const length = choose([2, 3, 4, 5, 6]);
    for (let index = 0; index < length; index++) {
      parts.push(
        choose(["\n", "\n\n", "\n\n\n", "\n \t\n", ""]),
        choose(fragments).replaceAll("{task}", label),
      );
    }
    parts.push(`\n\n# End\n\n- [x] ${label()}`, choose(["", "\n", "\n\n", "\n \t\n"]));
    return choose(["", "\n", "\n \t\n"]) + parts.join("");
  });
}

describe("note markdown fidelity", () => {
  it("preserves an empty parser suffix when the preceding source owns the boundary newline", () => {
    const source = "- [ ] active\n\n# S\n\n- p\n  ~~~\n> q\n";
    const doc = parse(source);
    expect(noteDocToMarkdown(doc.toJSON())).toBe(source);
    const task = doc.firstChild!.firstChild!;
    const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(1, undefined, {
      ...task.attrs,
      checked: true,
    }).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(source.replace("[ ]", "[x]"));
  });

  it.each([
    "[label]: /target\nTitle\n=====\n",
    "[label]: /target\nTitle\n---\n",
    "[a]: /one\n[b]: /two\nTitle\n=====\n",
  ])("preserves overlapping definition and setext heading source spans: %j", (snippet) => {
    const source = `- [ ] active\n\n# S\n\n${snippet}`;
    const doc = parse(source);
    expect(noteDocToMarkdown(doc.toJSON())).toBe(source);
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
    const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(1, undefined, {
      ...doc.firstChild!.firstChild!.attrs,
      checked: true,
    }).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(source.replace("[ ]", "[x]"));
  });

  it("preserves bytes and changes exactly one checkbox marker in 1,500 seeded documents", () => {
    let toggles = 0;
    const failures: string[] = [];
    for (const [index, source] of generatedDocuments(1_500).entries()) {
      const doc = parse(source);
      if (noteDocToMarkdown(doc.toJSON()) !== source)
        failures.push(`round trip ${index}: ${source}`);
      if (noteDocToMarkdown(withoutSourceCache(doc.toJSON())) !== source)
        failures.push(`uncached round trip ${index}: ${source}`);
      doc.descendants((node, pos) => {
        if (node.type.name !== "taskItem") return;
        const label = /probe\d+x\d+/.exec(node.firstChild!.textContent)?.[0];
        expect(label).toBeDefined();
        const labelOffset = source.indexOf(label!);
        expect(labelOffset).toBeGreaterThanOrEqual(0);
        expect(source.indexOf(label!, labelOffset + 1)).toBe(-1);
        const start = source.lastIndexOf("\n", labelOffset) + 1;
        const marker = /\[[ xX]\]/.exec(source.slice(start, labelOffset));
        expect(marker).not.toBeNull();
        const offset = start + marker!.index + 1;
        const expected =
          source.slice(0, offset) + (node.attrs.checked ? " " : "x") + source.slice(offset + 1);
        const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        }).doc;
        if (noteDocToMarkdown(changed.toJSON()) !== expected)
          failures.push(`toggle ${index} ${label}: ${source}`);
        toggles++;
      });
    }
    expect({ count: failures.length, examples: failures.slice(0, 3) }).toEqual({
      count: 0,
      examples: [],
    });
    expect(toggles).toBeGreaterThanOrEqual(1_500);
  });

  it.each(
    [...noteMarkdownFixtures, ...trickyMarkdown].flatMap((source) => [
      source,
      `\n \t\n${source}`,
      `- [ ] before\n\n# Snippet\n\n${source}\n# After\n\n- [x] after\n`,
    ]),
  )(
    "matches every structured block to one complete CommonMark/GFM top-level node: %j",
    (source) => {
      const expected = unified().use(remarkParse).use(remarkGfm).parse(source).children;
      const doc = noteMarkdownToDoc(source);
      if (!source) {
        expect(expected).toEqual([]);
        expect(doc.content).toEqual([{ type: "paragraph", attrs: { noteSuffix: "" } }]);
        return;
      }
      const kinds: Record<string, string> = {
        paragraph: "paragraph",
        heading: "heading",
        horizontalRule: "thematicBreak",
        codeBlock: "code",
        bulletList: "list",
        orderedList: "list",
        taskList: "list",
        blockquote: "blockquote",
      };
      const matched = new Set<number>();
      let offset = 0;
      for (const block of doc.content!) {
        offset += block.attrs?.notePrefix?.length ?? 0;
        const original =
          block.attrs?.noteSource ?? block.content?.map((child) => child.text ?? "").join("") ?? "";
        if (block.type !== "noteRawMarkdown") {
          const matches = expected.filter(
            (node) =>
              node.position!.start.offset === offset &&
              node.position!.end.offset === offset + original.length,
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]!.type).toBe(kinds[block.type!]);
          expect(original).toBe(source.slice(offset, offset + original.length));
          expect(matched.has(offset)).toBe(false);
          matched.add(offset);
        }
        offset += original.length + (block.attrs?.noteSuffix?.length ?? 0);
      }
      expect(offset).toBe(source.length);
    },
  );

  it("uses parser boundaries for lists outside an ordered item's content column", () => {
    const source = "10. parent\n   - [ ] literal\n";
    const doc = parse(source);
    expect(doc.content.content.map((node) => node.type.name)).toEqual(["orderedList", "taskList"]);
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it("keeps leading and inter-block whitespace when editing a positioned block", () => {
    const source = "\n \t\n   # Before\n \t\n   - [ ] task\n\n";
    const doc = parse(source);
    expect(doc.firstChild!.type.name).toBe("heading");
    const changed = EditorState.create({ schema, doc }).tr.insertText("edited ", 1).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(source.replace("# Before", "# edited Before"));
  });
  it.each(externalContainerFences)(
    "keeps external container fences and lazy continuations out of task structure: %j",
    (source) => {
      const doc = parse(source);
      doc.descendants((node) => {
        expect(node.type.name).not.toBe("taskItem");
      });
      expect(noteDocToMarkdown(doc.toJSON())).toBe(source);
      expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
    },
  );
  it.each(
    [" ", "  ", "   "].flatMap((indent) =>
      ["```", "~~~"].map(
        (fence) => `paragraph\n${indent}${fence}\n\n- [ ] literal\n\n${indent}${fence}\n`,
      ),
    ),
  )("keeps an indented fence that interrupts a paragraph out of task structure: %j", (source) => {
    const doc = parse(source);
    doc.descendants((node) => {
      expect(node.type.name).not.toBe("taskItem");
    });
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it.each(listCode)("does not expose code or misindented list content as tasks: %j", (source) => {
    const doc = parse(source);
    expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it.each(htmlBlocks)(
    "keeps a CommonMark HTML block raw through its end condition: %j",
    (source) => {
      const doc = parse(source);
      expect(doc.childCount).toBe(1);
      expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
      expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
    },
  );

  it.each(nonCanonical)(
    "requires canonical serialization before exposing structure: %j",
    (source) => {
      const doc = parse(source);
      expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
      const changed = EditorState.create({ schema, doc }).tr.insertText("edited ", 1).doc;
      expect(noteDocToMarkdown(changed.toJSON())).toBe("edited " + source);
    },
  );

  it.each([
    ["<pre>\n\n- [ ] literal\n</pre>\n", ""],
    ["<!--\n\n- [ ] literal\n-->\n", ""],
    ["<?target\n\n- [ ] literal\n?>\n", ""],
    ["<!DOCTYPE\n\n- [ ] literal\n>\n", ""],
    ["<![CDATA[\n\n- [ ] literal\n]]>\n", ""],
    ["<div>\n</div>\n# literal\n- [ ] literal\n", " \t\n"],
    ["<custom-tag>\n</custom-tag>\n# literal\n- [ ] literal\n", "\n"],
    ["<!-- one line -->\n", ""],
    ["<pre></pre>\n", ""],
  ])("resumes structured blocks immediately after the HTML end condition: %j", (html, blank) => {
    const source = `${html}${blank}# Outside\n\n- [ ] outside task\n`;
    const doc = parse(source);
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe("noteRawMarkdown");
    expect(doc.child(0).textContent).toBe(html.slice(0, -1));
    expect(doc.child(1).type.name).toBe("heading");
    expect(doc.child(2).type.name).toBe("taskList");
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it("lets types 1–6 interrupt a paragraph and consume apparent Markdown boundaries", () => {
    const source = "paragraph\n<!--\n\n- [ ] literal\n-->\n# Outside\n";
    const doc = parse(source);
    expect(doc.content.content.map((node) => node.type.name)).toEqual([
      "paragraph",
      "noteRawMarkdown",
      "heading",
    ]);
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it.each([
    "<custom-tag>",
    "<custom-tag a='quoted' />",
    "</custom-tag>",
    "<custom-tag missing=>",
    "<custom-tag",
    "<pre/>",
    "<prelude>inline</prelude>",
  ])("does not interrupt paragraphs with type 7 or invalid HTML starts: %j", (tag) => {
    const source = `paragraph\n${tag}\n# Outside\n`;
    const doc = parse(source);
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).textContent).toBe(`paragraph\n${tag}`);
    expect(doc.child(1).type.name).toBe("heading");
    expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
  });

  it("pads edited inline code whose significant value starts and ends with spaces", () => {
    const doc = parse("`original`\n");
    const changed = EditorState.create({ schema, doc }).tr.insertText(" code ", 1, 9).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe("`  code  `\n");
  });

  it.each([" ", "   ", " code", "code "])("does not pad code value %j unnecessarily", (value) => {
    const doc = parse("`original`\n");
    const changed = EditorState.create({ schema, doc }).tr.insertText(value, 1, 9).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(`\`${value}\`\n`);
  });

  it.each(trickyMarkdown)(
    "round trips bytes and changes only the exposed task's checkbox: %j",
    (snippet) => {
      // Headings keep the probes in distinct parser blocks, even beside loose lists.
      const wrapped = `- [ ] active before\n\n# Snippet\n\n${snippet}\n# After\n\n- [x] active after\n`;
      for (const source of [snippet, wrapped]) {
        const doc = parse(source);
        expect(noteDocToMarkdown(doc.toJSON())).toBe(source);
        expect(noteDocToMarkdown(withoutSourceCache(doc.toJSON()))).toBe(source);
        let toggled = 0;
        doc.descendants((node, pos) => {
          if (node.type.name !== "taskItem") return;
          toggled++;
          const label = node.firstChild!.textContent;
          const lines = source.split("\n");
          const lineIndex = lines.findIndex((line) => line.endsWith(`] ${label}`));
          expect(lineIndex).toBeGreaterThanOrEqual(0);
          const expected = [...lines];
          expected[lineIndex] = expected[lineIndex]!.replace(
            /\[[ xX]\]/,
            node.attrs.checked ? "[ ]" : "[x]",
          );
          const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            checked: !node.attrs.checked,
          }).doc;
          expect(noteDocToMarkdown(changed.toJSON())).toBe(expected.join("\n"));
        });
        if (source === wrapped && !snippet.includes("\r")) expect(toggled).toBeGreaterThan(0);
      }
    },
  );
});

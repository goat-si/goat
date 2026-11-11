import { describe, expect, it } from "vite-plus/test";

import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { goatBotReplyPartSource, splitGoatBotReply } from "./goatBotReplyParts";

const parser = unified().use(remarkParse).use(remarkGfm);
/** Where each link and reference in Markdown leads, in order, as the renderer's parser reads it. */
function resolved(markdown: string): Array<{ url: string; title: string | null } | null> {
  const tree = parser.parse(markdown);
  const defined = new Map<string, { url: string; title: string | null }>();
  const found: Array<{ url: string; title: string | null } | string> = [];
  const walk = (nodes: ReadonlyArray<Nodes>) => {
    for (const node of nodes) {
      if (node.type === "definition") {
        if (!defined.has(node.identifier))
          defined.set(node.identifier, { url: node.url, title: node.title ?? null });
        continue;
      }
      if (node.type === "link") found.push({ url: node.url, title: node.title ?? null });
      if (node.type === "linkReference") found.push(node.identifier);
      if ("children" in node) walk(node.children);
    }
  };
  walk(tree.children);
  return found.map((each) => (typeof each === "string" ? (defined.get(each) ?? null) : each));
}

const table = ["| Step | Tool | Result |", "| --- | :---: | ---: |", "| Read | `read` | 1 file |"];
const prose = (text: string) => [{ kind: "prose", text }];

describe("splitGoatBotReply", () => {
  it("splits an intro, a table and a closing into their own parts", () => {
    expect(
      splitGoatBotReply(["Done.", "", ...table, "", "Ask again any time."].join("\n")),
    ).toEqual([
      { kind: "prose", text: "Done." },
      { kind: "table", markdown: table.join("\n"), columns: 3 },
      { kind: "prose", text: "Ask again any time." },
    ]);
  });

  it("lets a table end the plain paragraph right above it", () => {
    expect(splitGoatBotReply(["Here it is:", ...table].join("\n"))).toEqual([
      { kind: "prose", text: "Here it is:" },
      { kind: "table", markdown: table.join("\n"), columns: 3 },
    ]);
  });

  it("counts an escaped pipe as part of its cell", () => {
    const rows = ["| A | B |", "| - | - |", "| x \\| y | z |"];
    expect(splitGoatBotReply(rows.join("\n"))).toEqual([
      { kind: "table", markdown: rows.join("\n"), columns: 2 },
    ]);
  });

  it("reads a header without a delimiter row, or with other column counts, as prose", () => {
    const loose = ["| A | B |", "| x | y |"].join("\n");
    const uneven = ["| A | B |", "| --- | --- | --- |", "| x | y |"].join("\n");
    expect(splitGoatBotReply(loose)).toEqual(prose(loose));
    expect(splitGoatBotReply(uneven)).toEqual(prose(uneven));
  });

  it("ends a table at a blank line or another block, and allows a table without rows", () => {
    const rows = ["| A | B |", "| - | - |", "| 1 |", "2 | 3 | 4", "> quoted"];
    expect(splitGoatBotReply(rows.join("\n"))).toEqual([
      { kind: "table", markdown: rows.slice(0, 4).join("\n"), columns: 2 },
      { kind: "prose", text: "> quoted" },
    ]);
    expect(splitGoatBotReply(["| A |", "| - |", "", "after"].join("\n"))).toEqual([
      { kind: "table", markdown: "| A |\n| - |", columns: 1 },
      { kind: "prose", text: "after" },
    ]);
  });

  it("leaves a table that may belong to a list, quote, HTML or indented code block as prose", () => {
    for (const text of [
      ["    | A | B |", "    | - | - |"].join("\n"),
      ["> | A | B |", "> | - | - |"].join("\n"),
      ["- item", "", "  | A | B |", "  | - | - |"].join("\n"),
      ["- item", "| A | B |", "| - | - |"].join("\n"),
      ["<div>", "| A | B |", "| - | - |", "</div>"].join("\n"),
      ["<!--", "", "| A | B |", "| - | - |", "-->"].join("\n"),
      ["<pre>", "", "| A | B |", "| - | - |", "</pre>"].join("\n"),
    ]) {
      expect(splitGoatBotReply(text)).toEqual(prose(text));
    }
  });

  it("keeps a fence open until a bare closing fence of its kind and length", () => {
    const text = ["~~~~", "```", ...table, "~~~", "~~~~ not a closer", "still code", "~~~~"].join(
      "\n",
    );
    expect(splitGoatBotReply(text)).toEqual(prose(text));
  });

  it("carries a definition into each card that refers to it, so every link resolves where the whole reply sends it", () => {
    const shapes = [
      ["See [the notes][x].", "[x]: https://example.com/notes"],
      ["See [the notes][x].", '[x]: https://example.com/notes "The notes"'],
      ["See [the notes][x].", "[x]: <https://example.com/a b>"],
      ["See [the  Notes][].", "[the notes]: https://example.com/notes"],
      ["See [x].", "[x]:", "  https://example.com/notes"],
      ["See [a b][a b].", "[a", "b]: https://example.com/notes"],
    ];
    for (const [words = "", ...definition] of shapes) {
      // The table refers to it as well, and the definition is written after the table.
      const cells = ["| Step | Link |", "| --- | --- |", "| Read | " + words + " |"];
      const text = [words, "", ...cells, "", ...definition].join("\n");
      const parts = splitGoatBotReply(text);
      expect(parts.map((part) => part.kind)).toEqual(["prose", "table", "prose"]);
      expect(parts.flatMap((part) => resolved(goatBotReplyPartSource(part)))).toEqual(
        resolved(text),
      );
      expect(resolved(text).every((destination) => destination !== null)).toBe(true);
      // A card carries a definition from elsewhere once, and the one that holds it adds none.
      expect(parts[2]?.definitions).toBeUndefined();
      expect(parts[0]?.definitions).toBe(definition.join("\n"));
    }
  });

  it("carries only the definitions a card uses", () => {
    const text = [
      "Read [one][a].",
      "",
      ...table,
      "",
      "[a]: https://example.com/a",
      "[b]: https://example.com/b",
      "Then [two][b].",
    ].join("\n");
    const parts = splitGoatBotReply(text);
    expect(parts[0]?.definitions).toBe("[a]: https://example.com/a");
    expect(parts[1]?.definitions).toBeUndefined();
    expect(parts.flatMap((part) => resolved(goatBotReplyPartSource(part)))).toEqual(resolved(text));
  });

  it("keeps a reply whole when a definition cannot be carried exactly", () => {
    for (const shape of [
      // Inside a list item or quote, written twice, or a footnote.
      ["See [x].", "", ...table, "", "- [x]: https://example.com"],
      ["See [x].", "", ...table, "", "> [x]: https://example.com"],
      ["See [x].", "", ...table, "", "[x]: https://example.com/1", "[x]: https://example.com/2"],
      ["See [^1].", "", ...table, "", "[^1]: A footnote."],
    ]) {
      const text = shape.join("\n");
      expect(splitGoatBotReply(text)).toEqual(prose(text));
    }
  });

  it("decides each table from what it has read so far, so a long held run stays prose", () => {
    const pairs = Array.from({ length: 2000 }, () => "| A |\n| - |").join("\n");
    const text = `- item\n${pairs}`;
    expect(splitGoatBotReply(text)).toEqual(prose(text));
    expect(splitGoatBotReply(`${text}\n\n${table.join("\n")}`).at(-1)).toEqual({
      kind: "table",
      markdown: table.join("\n"),
      columns: 3,
    });
  });

  it("keeps a row that starts with an autolink or inline HTML in its table", () => {
    for (const first of ["<https://example.com> | value", "<strong>Done</strong> | value"]) {
      const rows = ["| A | B |", "| - | - |", first];
      expect(splitGoatBotReply(rows.join("\n"))).toEqual([
        { kind: "table", markdown: rows.join("\n"), columns: 2 },
      ]);
    }
  });

  it("returns one prose part for text without a table", () => {
    expect(splitGoatBotReply("Just words.")).toEqual(prose("Just words."));
  });

  it("splits a table indented up to three spaces when no list or quote could hold it", () => {
    const rows = ["  | A | B |", "   | - | - |", "  | 1 | 2 |"];
    expect(splitGoatBotReply(["Intro", "", ...rows].join("\n"))).toEqual([
      { kind: "prose", text: "Intro" },
      { kind: "table", markdown: rows.join("\n"), columns: 2 },
    ]);
  });

  it("splits a table whose header starts with inline HTML", () => {
    const rows = ["<strong>A</strong> | B", "| - | - |", "| 1 | 2 |"];
    expect(splitGoatBotReply(rows.join("\n"))).toEqual([
      { kind: "table", markdown: rows.join("\n"), columns: 2 },
    ]);
  });

  it("splits a reply whose definition-shaped line is code, which defines nothing", () => {
    for (const code of [
      ["```", "[x]: https://example.com", "```"],
      ["    [x]: https://example.com"],
    ]) {
      const text = ["Intro", "", ...table, "", ...code].join("\n");
      // It stays where it was written, and no card carries it.
      expect(splitGoatBotReply(text)).toEqual([
        { kind: "prose", text: "Intro" },
        { kind: "table", markdown: table.join("\n"), columns: 3 },
        { kind: "prose", text: code.join("\n") },
      ]);
      expect(splitGoatBotReply(text).some((part) => part.definitions !== undefined)).toBe(false);
    }
  });

  it("lets a list or quote end at an unindented paragraph, so what follows splits as usual", () => {
    const rows = ["  | A | B |", "  | - | - |"];
    for (const container of ["- item", "> quoted"]) {
      expect(splitGoatBotReply([container, "", "After.", "", ...rows].join("\n"))).toEqual([
        { kind: "prose", text: [container, "", "After."].join("\n") },
        { kind: "table", markdown: rows.join("\n"), columns: 2 },
      ]);
      const code = "    [x]: https://example.com";
      const text = [container, "", "After.", "", ...table, "", code].join("\n");
      expect(splitGoatBotReply(text).at(-1)).toEqual({ kind: "prose", text: code });
    }
  });
});

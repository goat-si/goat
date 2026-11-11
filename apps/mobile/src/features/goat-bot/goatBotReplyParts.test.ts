import { describe, expect, it } from "vite-plus/test";

import { splitGoatBotReply } from "./goatBotReplyParts";

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

  it("keeps a reply with link reference definitions whole, so its links resolve", () => {
    for (const definition of [
      ["[x]: https://example.com"],
      ["[x]:", "  https://example.com"],
      ["[a\\]b]: https://example.com"],
    ]) {
      const text = ["See [the notes][x].", "", ...table, "", ...definition].join("\n");
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
      expect(splitGoatBotReply(text)).toEqual([
        { kind: "prose", text: "Intro" },
        { kind: "table", markdown: table.join("\n"), columns: 3 },
        { kind: "prose", text: code.join("\n") },
      ]);
    }
  });

  it("keeps a reply whole when a definition's label runs onto the next line", () => {
    const text = ["See [a b][a b].", "", ...table, "", "[a", "b]: https://example.com"].join("\n");
    expect(splitGoatBotReply(text)).toEqual(prose(text));
  });
});

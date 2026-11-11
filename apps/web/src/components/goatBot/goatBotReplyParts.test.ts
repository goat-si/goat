import { describe, expect, it } from "vite-plus/test";

import { goatBotReplySplit } from "./goatBotReplyParts";

const table = ["| Plan | Price |", "| --- | ---: |", "| Basic | $5 |", "| Pro | $20 |"].join("\n");

const parts = (text: string) => goatBotReplySplit(text).parts;
const kinds = (text: string) => parts(text).map((part) => part.kind);
const texts = (text: string) => parts(text).map((part) => part.text);
const sources = (text: string) => parts(text).map((part) => part.source);

describe("goatBotReplySplit", () => {
  it("splits an answer into its opening text, the table and the closing text", () => {
    expect(texts(`Here are the plans:\n\n${table}\n\nPro adds sync.`)).toEqual([
      "Here are the plans:",
      table,
      "Pro adds sync.",
    ]);
    expect(kinds(`Here are the plans:\n\n${table}\n\nPro adds sync.`)).toEqual([
      "text",
      "table",
      "text",
    ]);
  });

  it("gives each of two tables its own part", () => {
    const other = "a | b\n-|-\n1 | 2";
    expect(kinds(`${table}\n\nAnd:\n${other}`)).toEqual(["table", "text", "table"]);
  });

  it("keeps a reply that is only a table as one table part", () => {
    expect(kinds(table)).toEqual(["table"]);
    expect(texts(table)).toEqual([table]);
    expect(goatBotReplySplit(table).linkUrls).toBeUndefined();
  });

  it("groups the blocks around a table into one text part, byte-exact", () => {
    const text = `# Plans\n\nPick one:\n\n${table}\n\n- Pro adds sync\n- Basic does not`;
    const [opening, , closing] = texts(text);
    expect(opening).toBe("# Plans\n\nPick one:");
    expect(closing).toBe("- Pro adds sync\n- Basic does not");
  });

  it("keeps each part's source equal to the original text it covers", () => {
    const text = `Plans:\n\n${table}\n\nDone.`;
    for (const part of parts(text)) expect(text).toContain(part.source);
    expect(sources(text)).toEqual(texts(text));
  });

  it("leaves a table in a fenced block inside a list item in its text", () => {
    const text = [
      "Example:",
      "",
      "- ```md",
      `  ${table.replaceAll("\n", "\n  ")}`,
      "  ```",
      "",
      "Done.",
    ].join("\n");
    expect(parts(text)).toEqual([{ kind: "text", text, source: text }]);
  });

  it("leaves a table indented as code, and a quoted table, in its text", () => {
    const indented = `    | a | b |\n    | --- | --- |\n    | 1 | 2 |`;
    expect(kinds(indented)).toEqual(["text"]);
    const quoted = `> | a | b |\n> | --- | --- |\n> | 1 | 2 |`;
    expect(kinds(quoted)).toEqual(["text"]);
  });

  it("keeps a body row without pipes in the table, so its copy holds every row", () => {
    expect(texts(`| Plan | Price |\n| --- | --- |\n| Basic | $5 |\none`)).toEqual([
      `| Plan | Price |\n| --- | --- |\n| Basic | $5 |\none`,
    ]);
  });

  it("keeps an answer without a table whole, and pipes without a separator are text", () => {
    const text = "Run `a | b` then\n| not | a table |";
    expect(goatBotReplySplit(text)).toEqual({ parts: [{ kind: "text", text, source: text }] });
  });

  it("carries a definition written after the table into the card that refers to it", () => {
    const text = `[ref][x] and [^1]\n\n${table}\n\n[x]: https://a.dev\n[^1]: A note.`;
    const split = goatBotReplySplit(text);
    expect(split.parts[0]?.source).toBe(`[ref][x] and [^1]\n\n[x]: https://a.dev\n\n[^1]: A note.`);
    // The table card refers to neither, so it carries neither; a definition renders nothing.
    expect(split.parts[1]?.source).toBe(table);
  });

  it("carries only the definitions a card refers to, so a footnote lists once", () => {
    const text = `First [^a].\n\n${table}\n\nLast [^b].\n\n[^a]: One.\n[^b]: Two.`;
    const split = goatBotReplySplit(text);
    expect(split.parts[0]?.source).toBe(`First [^a].\n\n[^a]: One.`);
    expect(split.parts[2]?.source).toBe(`Last [^b].\n\n[^b]: Two.`);
  });

  it("keeps a definition written inside a card with it once", () => {
    const text = `Intro [^a]\n\n[^a]: One.\n\n${table}`;
    expect(sources(text)[0]).toBe(`Intro [^a]\n\n[^a]: One.`);
  });

  it("returns the same split for the same text, so a streamed row parses once", () => {
    const text = `Plans:\n\n${table}`;
    expect(goatBotReplySplit(text)).toBe(goatBotReplySplit(text));
  });
});

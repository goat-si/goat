import { describe, expect, it } from "vite-plus/test";
import { parseNoteMarkdown, type NoteMarkdownRangeType } from "./note-live-markdown-parser";
import { noteFallbackFixtures, noteSourceFixtures } from "./note-source-fixtures";

function styled(text: string, type: NoteMarkdownRangeType) {
  return parseNoteMarkdown(text)
    .filter((range) => range.type === type)
    .map((range) => text.slice(range.start, range.start + range.length));
}

describe("note live markdown parser", () => {
  it.each(Object.entries({ ...noteSourceFixtures, ...noteFallbackFixtures }))(
    "returns in-bounds, non-empty ranges in order, containers first, for %s",
    (_name, text) => {
      const ranges = parseNoteMarkdown(text);
      for (const [index, range] of ranges.entries()) {
        expect(range.length).toBeGreaterThan(0);
        expect(range.start + range.length).toBeLessThanOrEqual(text.length);
        const previous = ranges[index - 1];
        if (!previous) continue;
        // Native formatters apply ranges in order, so an outer style must precede inner ones.
        expect(range.start).toBeGreaterThanOrEqual(previous.start);
        if (range.start === previous.start)
          expect(range.length).toBeLessThanOrEqual(previous.length);
      }
    },
  );

  it("styles heading text and dims its markers at every level", () => {
    const text = noteSourceFixtures.headings!;
    expect(styled(text, "h1")).toEqual(["Title", "Second", "Sixth"]);
    expect(styled(text, "syntax")).toEqual(["# ", "## ", " ##", "###### "]);
  });

  it("styles emphasis, strikethrough and code without reading inside code", () => {
    const text = "**bold** *it* ***both*** ~~gone~~ `**raw**` __b__ _i_\n";
    expect(styled(text, "bold")).toEqual(["bold", "both", "b"]);
    expect(styled(text, "italic")).toEqual(["it", "both", "i"]);
    expect(styled(text, "strikethrough")).toEqual(["gone"]);
    expect(styled(text, "code")).toEqual(["**raw**"]);
  });

  it("leaves escapes and intraword underscores plain, as CommonMark does", () => {
    const text = noteSourceFixtures.escapes!;
    // Stars may emphasize inside a word ("2*3*4"); underscores may not.
    expect(styled(text, "italic")).toEqual(["3"]);
    expect(styled(text, "syntax")).toEqual(["\\", "\\", "*", "*"]);
  });

  it("nests inline styles inside links and emphasis", () => {
    const text = "**bold `code` and [link *it*](u)** after\n";
    expect(styled(text, "bold")).toEqual(["bold `code` and [link *it*](u)"]);
    expect(styled(text, "code")).toEqual(["code"]);
    expect(styled(text, "link")).toEqual(["link *it*"]);
    expect(styled(text, "italic")).toEqual(["it"]);
  });

  it("styles links, autolinks, bare URLs and images, and dims their syntax", () => {
    const text = noteSourceFixtures.links!;
    expect(styled(text, "link")).toEqual([
      "https://goat.si",
      "https://goat.si/path?x=1",
      "alt",
      "a [nested] b",
    ]);
    expect(styled(text, "syntax")).toEqual(["<", ">", "![", "](img.png)", "[", "](u)"]);
  });

  it("dims list markers and task boxes, and strikes done tasks", () => {
    const text = noteSourceFixtures.taskList!;
    expect(styled(text, "syntax")).toEqual(["-", "[ ]", "-", "[x]", "-", "[X]", "*", "[ ]"]);
    expect(styled(text, "strikethrough")).toEqual([" done task", " nested done"]);
  });

  it("formats fenced code as one block and ignores markdown inside it", () => {
    const text = noteSourceFixtures.codeFence!;
    expect(styled(text, "pre")).toEqual(["const a = **not bold**;", "nested `` ticks"]);
    expect(styled(text, "bold")).toEqual([]);
    // A shorter fence cannot close a longer one; an unclosed fence runs to the end.
    expect(styled(text, "pre").join("")).not.toContain("unclosed?");
  });

  it("closes a fence inside a quote and formats what follows", () => {
    const text = "> ```\n> code\n> ```\nafter **bold**\n";
    expect(styled(text, "pre")).toEqual(["code"]);
    expect(styled(text, "bold")).toEqual(["bold"]);
  });

  it("ends a quoted fence with its quote and keeps quote markers inside a top-level fence as code", () => {
    const quoted = "> ```\n> code\nafter **bold**\n";
    expect(styled(quoted, "pre")).toEqual(["code"]);
    expect(styled(quoted, "bold")).toEqual(["bold"]);
    const fenced = "```\n> not a quote\n```\n";
    expect(styled(fenced, "pre")).toEqual(["> not a quote"]);
    expect(styled(fenced, "blockquote")).toEqual([]);
  });

  it("finds a closing heading run only after a space, past long blank runs", () => {
    expect(styled("# a" + " ".repeat(5000) + "x\n", "h1")).toEqual(["a" + " ".repeat(5000) + "x"]);
    expect(styled("## Title ##  \n# C#\n### ###\n", "h1")).toEqual(["Title", "C#"]);
  });

  it("dims table pipes outside code and the delimiter row", () => {
    const text = noteSourceFixtures.table!;
    const pipes = styled(text, "syntax").filter((part) => part === "|");
    expect(pipes).toHaveLength(9);
    expect(styled(text, "syntax")).toContain("| :--- | ---: |");
    expect(styled(text, "code")).toEqual(["x|y"]);
    expect(styled(text, "bold")).toEqual(["bold"]);
  });

  it("marks nested quotes with their depth", () => {
    const ranges = parseNoteMarkdown(noteSourceFixtures.blockquote!).filter(
      (range) => range.type === "blockquote",
    );
    expect(ranges.map((range) => range.depth)).toEqual([1, 2, 1, 1]);
  });

  it("dims frontmatter, definitions, footnotes, comments and breaks", () => {
    expect(styled(noteSourceFixtures.frontmatterLike!, "syntax")).toEqual([
      "---\ntitle: Kept\ntags: [a, b]\n---",
    ]);
    expect(styled(noteSourceFixtures.referenceLinks!, "syntax")).toContain(
      '[docs]: https://goat.si/docs "Docs"',
    );
    expect(styled(noteSourceFixtures.footnotes!, "syntax")).toEqual(["[^1]", "[^1]:", "**", "**"]);
    // Markdown after a blank line inside an HTML block is markdown again.
    expect(styled(noteSourceFixtures.html!, "italic")).toEqual(["inside"]);
    expect(styled(noteSourceFixtures.html!, "syntax")).toEqual(["*", "*", "<!-- hidden -->"]);
    expect(styled(noteSourceFixtures.thematicBreak!, "syntax")).toEqual(["---", "* * *"]);
  });

  it("keeps UTF-16 offsets for Hangul, emoji and CRLF lines", () => {
    expect(styled(noteSourceFixtures.hangulEmoji!, "h1")).toEqual(["한글 제목 😀"]);
    expect(styled(noteSourceFixtures.hangulEmoji!, "bold")).toEqual(["굵은 한글"]);
    expect(styled(noteSourceFixtures.crlf!, "h1")).toEqual(["Title"]);
    expect(styled(noteSourceFixtures.crlf!, "bold")).toEqual(["bold"]);
  });

  it("stays linear on adversarial lines", () => {
    const stars = ("*a ".repeat(600) + "\n").repeat(50);
    const brackets = ("[".repeat(1500) + "\n").repeat(50);
    // Parsing finishes; long lines skip inline styles rather than rescanning.
    expect(parseNoteMarkdown(stars).length).toBeGreaterThanOrEqual(0);
    expect(styled("x".repeat(2001) + " **b**", "bold")).toEqual([]);
    expect(parseNoteMarkdown(brackets)).toEqual([]);
  });
});

import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";
import { noteExtensions } from "./noteExtensions";
import { noteMarkdownFixtures } from "./noteMarkdown.fixtures";
import { noteDocToMarkdown, noteMarkdownToDoc } from "./noteMarkdown";

const schema = getSchema(noteExtensions());
function parse(source: string) {
  const doc = schema.nodeFromJSON(noteMarkdownToDoc(source));
  doc.check();
  return doc;
}
describe("note markdown codec", () => {
  it("serializes edited fenced code with 200000 backtick runs without losing the edit", () => {
    const doc = parse("```md\noriginal\n```\n");
    const value = "`x".repeat(200000) + "edited";
    const changed = EditorState.create({ schema, doc }).tr.insertText(value, 1, 9).doc;
    const markdown = noteDocToMarkdown(changed.toJSON());
    expect(markdown).toBe(`\`\`\`md\n${value}\n\`\`\`\n`);
    expect(parse(markdown).firstChild!.textContent).toBe(value);
  });
  it("serializes inline code with 200000 backtick runs without exceeding the argument limit", () => {
    const value = "x`".repeat(200000) + "edited";
    const doc = schema.nodes.doc!.create(
      null,
      schema.nodes.paragraph!.create(null, schema.text(value, [schema.marks.code!.create()])),
    );
    expect(noteDocToMarkdown(doc.toJSON())).toBe(`\`\`${value}\`\`\n\n`);
  });
  it.each([
    "Before ``a`b`` after\n",
    "# Heading ``a`b``\n",
    "- [ ] Task ``a`b``\n",
    "- parent\n  - [ ] Task ``a`b``\n",
    "> Quoted ``a`b``\n",
    "Before ```a``b``` after\n",
    "Before `code\ncontinues` after\n",
    "- [ ] Task ` padded `\n",
  ])("keeps unsupported code delimiters raw through edits: %j", (source) => {
    const doc = parse(source);
    expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
    const changed = EditorState.create({ schema, doc }).tr.insertText("edited ", 1).doc;
    const markdown = noteDocToMarkdown(changed.toJSON());
    expect(markdown).toBe("edited " + source);
    // Editing raw text can create a new paragraph before an unsupported list on reload.
    expect(parse(markdown).lastChild!.type.name).toBe("noteRawMarkdown");
    expect(noteDocToMarkdown(parse(markdown).toJSON())).toBe(markdown);
  });
  it("preserves newly serialized multi-backtick inline code as raw markdown on reload", () => {
    const value = "a`b";
    const doc = schema.nodes.doc!.create(
      null,
      schema.nodes.paragraph!.create(null, schema.text(value, [schema.marks.code!.create()])),
    );
    const markdown = noteDocToMarkdown(doc.toJSON());
    const reloaded = parse(markdown);
    expect(reloaded.firstChild!.type.name).toBe("noteRawMarkdown");
    const changed = EditorState.create({ schema, doc: reloaded }).tr.insertText("edited ", 1).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe("edited " + markdown);
  });
  it.each([
    "    - [ ] keep this as code\n",
    "    1. keep this as code\n",
    "    - code\n",
    " \t- [ ] code\n",
  ])("keeps top-level indented code out of actionable lists: %j", (source) => {
    const doc = parse(source);
    expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
    expect(doc.toJSON().content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "taskList" })]),
    );
    const changed = EditorState.create({ schema, doc }).tr.insertText("edited ", 5).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(
      source.slice(0, 4) + "edited " + source.slice(4),
    );
  });
  it.each(noteMarkdownFixtures)("round trips fixture %j through the editor schema", (source) => {
    expect(noteDocToMarkdown(parse(source).toJSON())).toBe(source);
  });
  it.each(["-", "1.", "- [ ]"])(
    "keeps fingerprints proportional to deeply nested %s lists and detects edits",
    (marker) => {
      const source = Array.from(
        { length: 8 },
        (_, depth) => `${" ".repeat(depth * (marker === "1." ? 3 : 2))}${marker} item`,
      ).join("\n");
      const doc = parse(source);
      expect(doc.firstChild!.attrs.noteFingerprint.length).toBeLessThan(source.length * 32);
      expect(noteDocToMarkdown(doc.toJSON())).toBe(source);
      let lastText = 0;
      doc.descendants((node, pos) => {
        if (node.isText) lastText = pos;
      });
      const changed = EditorState.create({ schema, doc }).tr.insertText("changed ", lastText).doc;
      const markdown = noteDocToMarkdown(changed.toJSON());
      expect(markdown).toBe(source.slice(0, -4) + "changed item");
      expect(parse(markdown).textContent).toBe("item".repeat(7) + "changed item");
    },
  );
  it.each([
    "**`code`**",
    "*`code`*",
    "~~`code`~~",
    "***`code`***",
    "~~**`code`**~~",
    "~~*`code`*~~",
    "~~***`code`***~~",
  ])("keeps code text and emphasis when checking a task containing %s", (styled) => {
    const doc = parse(`- [ ] ${styled}\n`);
    const before = doc.firstChild!.firstChild!.firstChild!.firstChild!;
    expect(before.text).toBe("code");
    expect(before.marks.map((mark) => mark.type.name)).toContain("code");
    const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(1, undefined, {
      ...doc.firstChild!.firstChild!.attrs,
      checked: true,
    }).doc;
    const reloaded = parse(noteDocToMarkdown(changed.toJSON()));
    const after = reloaded.firstChild!.firstChild!.firstChild!.firstChild!;
    expect(reloaded.firstChild!.firstChild!.attrs.checked).toBe(true);
    expect(after.text).toBe("code");
    expect(after.marks).toEqual(before.marks);
  });
  it.each([
    "**before `code` after**",
    "*before `code` after*",
    "~~before `code` after~~",
    "**`code` and `other`**",
    "***before `code` after***",
    "~~**before `code` after**~~",
    "*before **`code`** after*",
    "**before *`code`* after**",
    "**before ~~`code`~~ after**",
    "~~before **`code`** after~~",
  ])("keeps shared emphasis across code and text when checking a task containing %s", (styled) => {
    const doc = parse(`- [ ] ${styled}\n`);
    const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(1, undefined, {
      ...doc.firstChild!.firstChild!.attrs,
      checked: true,
    }).doc;
    const reloaded = parse(noteDocToMarkdown(changed.toJSON()));
    expect(reloaded.firstChild!.firstChild!.attrs.checked).toBe(true);
    expect(reloaded.firstChild!.firstChild!.firstChild!.content).toEqual(
      doc.firstChild!.firstChild!.firstChild!.content,
    );
  });
  it.each([
    "> - one\n> - two\n",
    "> 1. one\n> 2. two\n",
    "> - [ ] one\n> - [x] two\n",
    "> paragraph\n> - one\n",
    "> # one\n",
    "> ```ts\n> one\n> ```\n",
    "> ~~~ts\n> one\n> ~~~\n",
    ">     one\n",
    "> one\n> ---\n",
    "> | one |\n> | --- |\n",
    "> > one\n",
    "> - parent\n>   - one\n>     ```ts\n>     code\n>     ```\n",
    "> - one\n>\n> - two\n",
    "- one\n  ```ts\n  code\n  ```\n",
    "- parent\n  - one\n    ```ts\n    code\n    ```\n",
    "1. parent\n   1. one\n      ~~~ts\n      code\n      ~~~\n",
    "- [ ] parent\n  - [ ] one\n    ```ts\n    code\n    ```\n",
    "- parent\n  > one\n  > two\n",
    "- > one\n",
    "- parent\n  - > one\n",
    "- parent\n  - child\n    > one\n",
    "- # one\n",
    "- parent\n  - # one\n",
    "- ```one\n",
    "- parent\n  - ---\n  - one\n",
  ])("preserves unsupported container children during edits: %j", (source) => {
    const doc = parse(source);
    expect(doc.firstChild!.type.name).toBe("noteRawMarkdown");
    const index = doc.firstChild!.textContent.indexOf("one");
    expect(index).toBeGreaterThanOrEqual(0);
    const changed = EditorState.create({ schema, doc }).tr.insertText("changed ", index + 1).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(source.replace("one", "changed one"));
  });
  it("edits supported quote paragraphs without making them raw", () => {
    const doc = parse("> one\n> two\n");
    expect(doc.firstChild!.type.name).toBe("blockquote");
    const changed = EditorState.create({ schema, doc }).tr.insertText("changed ", 2).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe("> changed one\n> two\n");
  });
  it("escapes newly typed literal inline markdown rather than changing its meaning on reload", () => {
    const doc = schema.nodes.doc!.create(
      null,
      schema.nodes.paragraph!.create(null, schema.text("literal **stars** and [brackets]")),
    );
    expect(noteDocToMarkdown(doc.toJSON())).toBe(
      "literal \\*\\*stars\\*\\* and \\[brackets\\]\n\n",
    );
  });
  it("keeps a boundary when Enter splits a paragraph that had no terminal newline", () => {
    const doc = parse("one");
    const attrs = doc.firstChild!.attrs;
    const split = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(attrs, schema.text("one")),
      schema.nodes.paragraph!.create(attrs, schema.text("two")),
    ]);
    expect(noteDocToMarkdown(split.toJSON())).toBe("one\n\ntwo");
  });
  it("edits a heading while preserving raw markdown and all surrounding whitespace", () => {
    const table = "|a|b|\n|---|---|\n|1|2|\n\n\n";
    const source = `# Before\n\n${table}[reference]: https://example.com\n`;
    const doc = parse(source);
    const state = EditorState.create({ schema, doc });
    const edited = state.tr.insertText("New ", 1).doc;
    expect(noteDocToMarkdown(edited.toJSON())).toBe(
      `# New Before\n\n${table}[reference]: https://example.com\n`,
    );
  });
  it("changes a task checkbox without flattening the list or dropping the next raw block", () => {
    const doc = parse("- [ ] Task\n- [x] Done\n\n<div>Keep me</div>\n");
    const state = EditorState.create({ schema, doc });
    const changed = state.tr.setNodeMarkup(1, undefined, {
      ...doc.firstChild!.firstChild!.attrs,
      checked: true,
    }).doc;
    expect(noteDocToMarkdown(changed.toJSON())).toBe(
      "- [x] Task\n- [x] Done\n\n<div>Keep me</div>\n",
    );
  });
  it("preserves unknown markdown in an editable literal node", () => {
    const doc = parse("| a |\n|---|\n| b |\n");
    expect(doc.firstChild?.type.name).toBe("noteRawMarkdown");
    const state = EditorState.create({ schema, doc });
    expect(noteDocToMarkdown(state.tr.insertText("new ", 1).doc.toJSON())).toBe(
      "new | a |\n|---|\n| b |\n",
    );
  });
  it("extends a fence when edited code contains its closing delimiter", () => {
    const doc = parse("```md\nhello\n```\n");
    const state = EditorState.create({ schema, doc });
    const markdown = noteDocToMarkdown(state.tr.insertText("\n```", 6).doc.toJSON());
    expect(markdown).toBe("````md\nhello\n```\n````\n");
    expect(parse(markdown).firstChild?.textContent).toBe("hello\n```");
  });
});

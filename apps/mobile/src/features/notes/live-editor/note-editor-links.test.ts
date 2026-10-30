import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { noteMarkdown } from "./note-editor-language";
import { noteLinkDefinitions, normalizeLinkLabel } from "./note-editor-links";
import { noteEditorFixtures } from "./note-editor-fixtures";

function definitions(text: string) {
  const state = EditorState.create({ doc: text, extensions: noteMarkdown });
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (!tree) throw new Error("parse timed out");
  return noteLinkDefinitions(tree, (from, to) => state.sliceDoc(from, to));
}

describe("reference links resolve to the definitions markdown recognizes", () => {
  const sink = definitions(noteEditorFixtures["kitchen sink (LF)"]!);

  it.each([
    ["full", "ref", "https://goat.si/ref"],
    ["collapsed", "collapsed", "https://goat.si/c"],
    ["shortcut", "Shortcut", "/relative/path"],
  ])("%s reference", (_kind, label, href) => {
    expect(sink.get(normalizeLinkLabel(label))).toBe(href);
  });

  it("ignores definition-shaped text in code and footnotes, and keeps the first real definition", () => {
    const found = definitions(
      [
        "```",
        "[a]: https://wrong.example",
        "```",
        "",
        "    [a]: https://indented.example",
        "",
        "[^a]: footnote",
        "",
        "[A]: /one",
        "",
        "> [quoted]: /in-quote",
        "",
        "[a]: /two",
      ].join("\n"),
    );
    expect(found.get("a")).toBe("/one");
    expect(found.get("quoted")).toBe("/in-quote");
    expect(found.has("^a")).toBe(false);
  });
});

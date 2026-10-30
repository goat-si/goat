import { describe, expect, it } from "vite-plus/test";
import { noteLinkDefinitions, normalizeLinkLabel } from "./note-editor-links";
import { noteEditorFixtures } from "./note-editor-fixtures";

describe("reference links resolve to their definitions", () => {
  const definitions = noteLinkDefinitions(noteEditorFixtures["kitchen sink (LF)"]!);

  it.each([
    ["full", "ref", "https://goat.si/ref"],
    ["collapsed", "collapsed", "https://goat.si/c"],
    ["shortcut", "Shortcut", "/relative/path"],
  ])("%s reference", (_kind, label, href) => {
    expect(definitions.get(normalizeLinkLabel(label))).toBe(href);
  });

  it("ignores footnote definitions and keeps the first definition of a label", () => {
    expect(definitions.has("^1")).toBe(false);
    expect(noteLinkDefinitions("[A]: /one\n[a]: /two\n").get("a")).toBe("/one");
  });
});

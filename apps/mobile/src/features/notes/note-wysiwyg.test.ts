import { describe, expect, it } from "vite-plus/test";
import { VISUAL_NOTE_FIXTURES as notes } from "./note-wysiwyg.fixtures";
import { openVisualNote, visualEditorBlocker, visualNoteBody } from "./note-wysiwyg";

describe("visual note editor eligibility", () => {
  it.each([
    ["headings", null],
    ["indentThree", null],
    // The AST allows these; the native round trip rewrites the indent, so they fall back on open.
    ["indentTwo", null],
    ["indentFour", null],
    ["checklist", "a checklist"],
    ["codeFence", "a code block"],
    ["table", "a table"],
    ["quote", "a quote"],
    ["html", "HTML"],
    ["referenceLink", "a reference link"],
    ["footnote", "a footnote"],
    ["frontmatter", "a divider"],
    ["korean", null],
    ["crlf", null],
    ["mixedEndings", "mixed line endings"],
    ["noTrailingNewline", null],
  ] as const)("%s opens visually only when every block renders as formatting", (name, reason) => {
    expect(visualEditorBlocker(notes[name])).toBe(reason);
  });

  it("refuses inline code and multi-line list items, which the input would show as raw text", () => {
    expect(visualEditorBlocker("Run `vp i` first\n")).toBe("inline code");
    expect(visualEditorBlocker("- item\n  continued\n")).toBe("a list item with several lines");
    expect(visualEditorBlocker("- item\n\n  more\n")).toBe("a list with blank lines between items");
  });

  it("refuses syntax the input's parser reads differently from remark", () => {
    expect(visualEditorBlocker("A ||secret|| word\n")).toBe("a || marker");
    expect(visualEditorBlocker("An _emphasis_ word\n")).toBe("underscore formatting");
    expect(visualEditorBlocker("A __strong__ word\n")).toBe("underscore formatting");
    expect(visualEditorBlocker("A *safe* and **safe** word\n")).toBeNull();
  });
});

describe("saving from the visual editor", () => {
  it.each(Object.keys(notes) as Array<keyof typeof notes>)(
    "%s saves its original bytes when the editor content is unchanged",
    (name) => {
      const session = openVisualNote(notes[name]);
      expect(visualNoteBody(session, session.text)).toBe(notes[name]);
    },
  );

  it("an edit to one line of a CRLF note changes only that line and keeps CRLF everywhere", () => {
    const session = openVisualNote(notes.crlf);
    expect(session.text).not.toContain("\r");
    const saved = visualNoteBody(
      session,
      session.text.replace("Second line", "Second **line**\nThird"),
    );
    expect(saved).toBe("# Title\r\n\r\nFirst line\r\nSecond **line**\r\nThird\r\n");
  });

  it("an edit to one line of an LF note leaves every other byte alone", () => {
    const session = openVisualNote(notes.korean);
    const saved = visualNoteBody(session, session.text.replace("- 둘째", "- 둘째 항목"));
    const before = notes.korean.split("\n");
    const after = saved.split("\n");
    expect(after.filter((line, index) => line !== before[index])).toEqual(["- 둘째 항목"]);
  });
});

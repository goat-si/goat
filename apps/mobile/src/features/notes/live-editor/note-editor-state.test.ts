import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { noteEditorFixtures, noteEditorSourceFixtures } from "./note-editor-fixtures";
import {
  continueMarkdownList,
  cycleHeading,
  noteEditorChanges,
  noteEditorExtensions,
  noteText,
  noteTextLength,
  replaceNoteText,
  toggleInlineMark,
  toggleTaskAt,
  toggleTaskList,
} from "./note-editor-state";
import { applyNoteEditorChanges, noteEditorSupport } from "./note-editor-support";

function open(body: string) {
  const support = noteEditorSupport(body);
  if (support.kind !== "live") throw new Error(support.reason);
  return EditorState.create({ doc: body, extensions: noteEditorExtensions(support.lineBreak) });
}

/** Runs one edit and returns the string React Native holds after the bridge applies it. */
function bridge(body: string, state: EditorState, run: (state: EditorState) => Transaction) {
  const lineBreak = state.lineBreak as "\n" | "\r\n";
  const tr = run(state);
  const received = applyNoteEditorChanges(
    body,
    noteEditorChanges(tr.startState.doc, tr.changes, lineBreak),
    noteTextLength(tr.state.doc, lineBreak),
  );
  expect(received).toBe(noteText(tr.state));
  return received!;
}

function command(
  state: EditorState,
  run: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean,
) {
  let next: Transaction | null = null;
  expect(run({ state, dispatch: (tr) => (next = tr) })).toBe(true);
  return next!;
}

const at = (body: string, needle: string, offset = 0) => {
  const index = body.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  return index + offset;
};
/** String offset to editor position, which counts each CRLF as one character. */
const pos = (body: string, offset: number) =>
  offset - (body.slice(0, offset).match(/\r\n/g)?.length ?? 0);

describe("note live editor keeps the original bytes", () => {
  it.each(Object.entries(noteEditorFixtures))("opens and saves %s unchanged", (_name, body) => {
    const state = open(body);
    expect(noteText(state)).toBe(body);
    expect(noteTextLength(state.doc, state.lineBreak as "\n")).toBe(body.length);
    expect(replaceNoteText(state, body)).toBeNull();
  });

  it.each(Object.entries(noteEditorSourceFixtures))(
    "sends %s to the source editor with a reason",
    (_name, body) => {
      const support = noteEditorSupport(body);
      expect(support.kind).toBe("source");
      expect(support.kind === "source" && support.reason).toMatch(/opens as markdown source/);
    },
  );
});

describe.each([
  ["LF", noteEditorFixtures["kitchen sink (LF)"]!],
  ["CRLF", noteEditorFixtures["kitchen sink (CRLF)"]!],
])("one edit changes only its own bytes (%s)", (_name, body) => {
  const lineBreak = body.includes("\r\n") ? "\r\n" : "\n";
  const replace = (from: number, to: number, insert: string) =>
    body.slice(0, from) + insert + body.slice(to);

  it("checking a task flips one character", () => {
    const marker = at(body, "- [ ] open task", 2);
    const state = open(body);
    const next = bridge(body, state, (s) => s.update(toggleTaskAt(s, pos(body, marker))!));
    expect(next).toBe(replace(marker + 1, marker + 2, "x"));
  });

  it("unchecking a task flips one character", () => {
    const marker = at(body, "- [x] done task", 2);
    const next = bridge(body, open(body), (s) => s.update(toggleTaskAt(s, pos(body, marker))!));
    expect(next).toBe(replace(marker + 1, marker + 2, " "));
  });

  it("bolding a selected word wraps only that word", () => {
    const word = at(body, "Quote line", 6);
    const next = bridge(body, open(body), (s) =>
      command(
        s.update({ selection: EditorSelection.range(pos(body, word), pos(body, word) + 4) }).state,
        toggleInlineMark("**"),
      ),
    );
    expect(next).toBe(replace(word, word + 4, "**line**"));
  });

  it("typing Hangul in the middle of a line inserts only the typed text", () => {
    const where = at(body, "가나다라", 2);
    const next = bridge(body, open(body), (s) =>
      s.update({ changes: { from: pos(body, where), insert: "한글" } }),
    );
    expect(next).toBe(replace(where, where, "한글"));
  });

  it("pressing Enter in a task list starts the next task with the note's line break", () => {
    const end = at(body, "- [ ] open task") + "- [ ] open task".length;
    const next = bridge(body, open(body), (s) =>
      command(s.update({ selection: { anchor: pos(body, end) } }).state, continueMarkdownList),
    );
    expect(next).toBe(replace(end, end, lineBreak + "- [ ] "));
  });

  it("pressing Enter in an ordered list numbers the next item and leaves later items alone", () => {
    const end = at(body, "1. first") + "1. first".length;
    const next = bridge(body, open(body), (s) =>
      command(s.update({ selection: { anchor: pos(body, end) } }).state, continueMarkdownList),
    );
    expect(next).toBe(replace(end, end, lineBreak + "2. "));
  });

  it("Enter inside a code fence is not treated as a list", () => {
    const end = at(body, "// - [ ] not a task") + "// - [ ] not a task".length;
    const state = open(body).update({ selection: { anchor: pos(body, end) } }).state;
    expect(continueMarkdownList({ state, dispatch: () => {} })).toBe(false);
  });

  it("the heading button changes only the heading marker", () => {
    const line = at(body, "# Weekly sync");
    const next = bridge(body, open(body), (s) =>
      command(s.update({ selection: { anchor: pos(body, line) + 3 } }).state, cycleHeading),
    );
    expect(next).toBe(replace(line, line + 1, "##"));
  });

  it("the checkbox button turns a bullet into a task without touching its text", () => {
    const line = at(body, "* star bullet");
    const next = bridge(body, open(body), (s) =>
      command(s.update({ selection: { anchor: pos(body, line) + 4 } }).state, toggleTaskList),
    );
    expect(next).toBe(replace(line + 2, line + 2, "[ ] "));
  });

  it("pasted text takes the note's line breaks", () => {
    const where = at(body, "Trailing spaces");
    const next = bridge(body, open(body), (s) =>
      s.update({ changes: { from: pos(body, where), insert: "a\r\nb\nc\rd " } }),
    );
    expect(next).toBe(replace(where, where, ["a", "b", "c", "d "].join(lineBreak)));
  });

  it("a hub update replaces only the changed span and keeps the cursor", () => {
    const where = at(body, "Footnote here");
    const updated = replace(where, where + "Footnote".length, "Fußnote");
    const state = open(body).update({
      selection: { anchor: pos(body, at(body, "Trailing")) },
    }).state;
    const next = state.update(replaceNoteText(state, updated)!).state;
    expect(noteText(next)).toBe(updated);
    expect(next.sliceDoc(next.selection.main.head).startsWith("Trailing")).toBe(true);
  });
});

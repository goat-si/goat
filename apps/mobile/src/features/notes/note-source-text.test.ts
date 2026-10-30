import { describe, expect, it } from "vite-plus/test";
import {
  LIVE_MARKDOWN_MAX_LENGTH,
  applyNoteEditorChange,
  noteEditorFallback,
  noteEditorView,
} from "./note-source-text";
import { noteFallbackFixtures, noteSourceFixtures } from "./note-source-fixtures";

const supported = Object.entries(noteSourceFixtures);

function commonPrefix(a: string, b: string) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

function commonSuffix(a: string, b: string) {
  let length = 0;
  while (
    length < a.length &&
    length < b.length &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  )
    length++;
  return length;
}

/** Edits the editor view at a source position, as the native input would report it. */
function editAt(
  source: string,
  sourceOffset: number,
  deleted: number,
  inserted: string,
  withSelection: boolean,
) {
  const view = noteEditorView(source);
  const viewOffset = noteEditorView(source.slice(0, sourceOffset)).length;
  const next = view.slice(0, viewOffset) + inserted + view.slice(viewOffset + deleted);
  const selection = withSelection ? { start: viewOffset, end: viewOffset + deleted } : null;
  return { next, result: applyNoteEditorChange(source, view, next, selection) };
}

/** Offsets inside each line's text, never between a CR and its LF. */
function lineOffsets(source: string) {
  const offsets: number[] = [];
  let lineStart = 0;
  for (const line of source.split("\n")) {
    const content = line.endsWith("\r") ? line.length - 1 : line.length;
    offsets.push(lineStart + Math.floor(content / 2));
    lineStart += line.length + 1;
  }
  return offsets;
}

describe("note source text", () => {
  it.each(supported)(
    "keeps every byte of %s when the note is opened and saved",
    (_name, source) => {
      expect(noteEditorFallback(source)).toBeNull();
      const view = noteEditorView(source);
      expect(view).not.toContain("\r");
      expect(applyNoteEditorChange(source, view, view)).toBe(source);
    },
  );

  it.each(supported)("changes only the edited span of %s", (_name, source) => {
    for (const offset of lineOffsets(source)) {
      const deletable = source.slice(offset).search(/\r?\n|$/);
      for (const [deleted, inserted] of [
        [0, "X"],
        [Math.min(1, deletable), ""],
        [Math.min(2, deletable), "한글"],
      ] as const) {
        for (const withSelection of [false, true]) {
          const { next, result } = editAt(source, offset, deleted, inserted, withSelection);
          expect(noteEditorView(result)).toBe(next);
          expect(commonPrefix(source, result)).toBeGreaterThanOrEqual(offset);
          expect(commonSuffix(source, result)).toBeGreaterThanOrEqual(
            source.length - offset - deleted,
          );
          expect(result.length).toBe(source.length - deleted + inserted.length);
        }
      }
    }
  });

  it("keeps CRLF elsewhere while Hangul composes and a line break is typed", () => {
    const source = noteSourceFixtures.crlf!;
    const at = source.indexOf("task") + "task".length;
    let previous = noteEditorView(source);
    let current = source;
    // Each composition step replaces the syllable in progress, then Enter starts a new line.
    for (const typed of [" ㅎ", " 하", " 한", " 한\n"]) {
      const viewAt = noteEditorView(source.slice(0, at)).length;
      const next = previous.slice(0, viewAt) + typed + noteEditorView(source).slice(viewAt);
      current = applyNoteEditorChange(current, previous, next);
      previous = next;
    }
    expect(current).toBe("# Title\r\n\r\n- [ ] task 한\r\n\r\n**bold**\r\n");
  });

  it("uses the file's majority line ending for typed and pasted line breaks", () => {
    const lf = "a\nb\n";
    expect(applyNoteEditorChange(lf, lf, "a\nx\ny\nb\n")).toBe("a\nx\ny\nb\n");
    const crlf = "a\r\nb\r\n";
    expect(applyNoteEditorChange(crlf, "a\nb\n", "a\nx\r\ny\nb\n")).toBe("a\r\nx\r\ny\r\nb\r\n");
    const mixed = "a\r\nb\nc\n";
    expect(applyNoteEditorChange(mixed, "a\nb\nc\n", "a\nb\nx\nc\n")).toBe("a\r\nb\nx\nc\n");
  });

  it("uses the cursor to tell apart equal neighbors with different line endings", () => {
    const source = "a\r\n\nb";
    // With the cursor between the two breaks, the change reads as a forward delete until the
    // selection after it shows the cursor moved back, as backspace does.
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", { start: 2, end: 2 })).toBe("a\r\nb");
    // A selection already moved back is only explained by backspace.
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", { start: 1, end: 1 })).toBe("a\nb");
    // Backspace after the second break keeps the first one's CRLF.
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", { start: 3, end: 3 })).toBe("a\r\nb");
    // A replaced selection changes only the selected text.
    expect(applyNoteEditorChange("x\r\nx\r\nx", "x\nx\nx", "x\ny\nx", { start: 2, end: 3 })).toBe(
      "x\r\ny\r\nx",
    );
  });

  it("reads a deletion between mixed line endings by the key that made it", () => {
    const source = "a\r\n\nb";
    const cursor = { start: 2, end: 2 };
    // Backspace removes the first break; forward delete, which reports no key, the second.
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", cursor, true)).toBe("a\nb");
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", cursor, false)).toBe("a\r\nb");
    // A selection already moved back by the backspace gives the same answer.
    expect(applyNoteEditorChange(source, "a\n\nb", "a\nb", { start: 1, end: 1 }, true)).toBe(
      "a\nb",
    );
  });

  it("joins lines by removing the whole CRLF", () => {
    const source = "one\r\ntwo\r\n";
    expect(applyNoteEditorChange(source, "one\ntwo\n", "onetwo\n")).toBe("onetwo\r\n");
  });

  it("opens notes it cannot round-trip in the plain editor, with a reason", () => {
    expect(noteEditorFallback(noteFallbackFixtures.nul!)).toBe("control-characters");
    expect(noteEditorFallback(noteFallbackFixtures.loneSurrogate!)).toBe("control-characters");
    expect(noteEditorFallback(noteFallbackFixtures.loneCarriageReturn!)).toBe("carriage-returns");
    expect(noteEditorFallback("x".repeat(LIVE_MARKDOWN_MAX_LENGTH + 1))).toBe("large");
    expect(noteEditorFallback("emoji 😀 pairs are fine")).toBeNull();
  });
});

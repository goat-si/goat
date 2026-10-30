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
function editAt(source: string, sourceOffset: number, deleted: number, inserted: string) {
  const view = noteEditorView(source);
  const viewOffset = noteEditorView(source.slice(0, sourceOffset)).length;
  const next = view.slice(0, viewOffset) + inserted + view.slice(viewOffset + deleted);
  return { next, result: applyNoteEditorChange(source, view, next) };
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
        const { next, result } = editAt(source, offset, deleted, inserted);
        expect(noteEditorView(result)).toBe(next);
        expect(commonPrefix(source, result)).toBeGreaterThanOrEqual(offset);
        expect(commonSuffix(source, result)).toBeGreaterThanOrEqual(
          source.length - offset - deleted,
        );
        expect(result.length).toBe(source.length - deleted + inserted.length);
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

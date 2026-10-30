// Native text inputs may not keep CRLF, so the editor shows an LF view and each change is
// spliced back into the exact source; text outside the changed span keeps its original bytes.

/** Above this, the full reparse on every keystroke (UI thread on Android) can drop frames. */
export const LIVE_MARKDOWN_MAX_LENGTH = 100_000;

export type NoteEditorFallback = "large" | "control-characters" | "carriage-returns";

/** Why a note opens in the plain editor, or null when the formatted editor can hold it. */
export function noteEditorFallback(source: string): NoteEditorFallback | null {
  if (source.length > LIVE_MARKDOWN_MAX_LENGTH) return "large";
  // NUL and unpaired surrogates have no stable round trip through native text views. With the
  // u flag, a surrogate class only matches unpaired halves.
  if (/\0|[\uD800-\uDFFF]/u.test(source)) return "control-characters";
  if (/\r(?!\n)/.test(source)) return "carriage-returns";
  return null;
}

export function noteEditorFallbackMessage(reason: NoteEditorFallback): string {
  switch (reason) {
    case "large":
      return "This note is large, so formatting is off while you edit.";
    case "control-characters":
      return "This note has characters the formatted editor can't keep, so formatting is off.";
    case "carriage-returns":
      return "This note uses old Mac line endings, so formatting is off to keep them.";
  }
}

export function noteEditorView(source: string): string {
  return source.includes("\r") ? source.replaceAll("\r\n", "\n") : source;
}

function sourceOffset(source: string, viewOffset: number): number {
  let view = 0;
  let index = 0;
  while (view < viewOffset) {
    index += source.charCodeAt(index) === 13 && source.charCodeAt(index + 1) === 10 ? 2 : 1;
    view++;
  }
  return index;
}

/** Applies the edit that turned `previousView` into `nextView` to the source text. */
export function applyNoteEditorChange(
  source: string,
  previousView: string,
  nextView: string,
): string {
  if (previousView === nextView) return source;
  let start = 0;
  const shortest = Math.min(previousView.length, nextView.length);
  while (start < shortest && previousView.charCodeAt(start) === nextView.charCodeAt(start)) start++;
  let suffix = 0;
  while (
    suffix < shortest - start &&
    previousView.charCodeAt(previousView.length - 1 - suffix) ===
      nextView.charCodeAt(nextView.length - 1 - suffix)
  )
    suffix++;
  let inserted = nextView.slice(start, nextView.length - suffix).replaceAll("\r\n", "\n");
  if (source.includes("\r\n") && inserted.includes("\n")) {
    const crlf = source.split("\r\n").length - 1;
    const lf = source.split("\n").length - 1 - crlf;
    // Typed or pasted line breaks follow the file's majority line ending.
    if (crlf >= lf) inserted = inserted.replaceAll("\n", "\r\n");
  }
  const from = sourceOffset(source, start);
  const to = sourceOffset(source, previousView.length - suffix);
  return source.slice(0, from) + inserted + source.slice(to);
}

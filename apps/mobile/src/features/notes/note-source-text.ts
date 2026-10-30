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
  // Each CRLF before the view offset adds its CR; jump between them with the native search.
  let carriageReturns = 0;
  let at = source.indexOf("\r\n");
  while (at !== -1 && at - carriageReturns < viewOffset) {
    carriageReturns++;
    at = source.indexOf("\r\n", at + 2);
  }
  return viewOffset + carriageReturns;
}

export interface NoteEditorSelection {
  readonly start: number;
  readonly end: number;
}

function explains(previous: string, next: string, from: number, to: number) {
  const nextEnd = to + next.length - previous.length;
  return (
    from >= 0 &&
    to <= previous.length &&
    nextEnd >= from &&
    previous.slice(0, from) === next.slice(0, from) &&
    previous.slice(to) === next.slice(nextEnd)
  );
}

/** Where the edit is, as [from, to) in the previous view and its end in the next view. */
function editSpan(
  previous: string,
  next: string,
  selection: NoteEditorSelection | null,
  backspace: boolean,
) {
  const delta = next.length - previous.length;
  if (selection) {
    const { start, end } = selection;
    // Only a placement that explains the change is used, so equal neighbors, such as two line
    // breaks with different source endings, resolve to the one at the cursor. The selection may
    // already be the one after the change, so both sides of the cursor are tried; the Backspace
    // key decides which side a deletion tries first.
    const candidates: Array<readonly [number, number]> = [];
    if (end > start) candidates.push([start, end]);
    if (delta < 0) {
      const before = [start + delta, start] as const;
      const after = [start, start - delta] as const;
      candidates.push(...(backspace ? [before, after] : [after, before]));
    } else candidates.push([start, start], [start - delta, start - delta]);
    for (const [from, to] of candidates)
      if (explains(previous, next, from, to)) return { from, to, nextEnd: to + delta };
  }
  const shortest = Math.min(previous.length, next.length);
  // Skip the text far from the cursor with native comparisons; a character loop is slow on Hermes.
  let from = selection ? Math.max(0, Math.min(selection.start, shortest) - 64) : 0;
  if (previous.slice(0, from) !== next.slice(0, from)) from = 0;
  while (from < shortest && previous.charCodeAt(from) === next.charCodeAt(from)) from++;
  let suffix = selection ? Math.max(0, previous.length - selection.end - 64) : 0;
  suffix = Math.min(suffix, shortest - from);
  if (previous.slice(previous.length - suffix) !== next.slice(next.length - suffix)) suffix = 0;
  while (
    suffix < shortest - from &&
    previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  )
    suffix++;
  return { from, to: previous.length - suffix, nextEnd: next.length - suffix };
}

/** Applies the edit that turned `previousView` into `nextView` to the source text. */
export function applyNoteEditorChange(
  source: string,
  previousView: string,
  nextView: string,
  selection: NoteEditorSelection | null = null,
  backspace = false,
): string {
  if (previousView === nextView) return source;
  const span = editSpan(previousView, nextView, selection, backspace);
  let inserted = nextView.slice(span.from, span.nextEnd).replaceAll("\r\n", "\n");
  if (source.includes("\r\n") && inserted.includes("\n")) {
    const crlf = source.split("\r\n").length - 1;
    const lf = source.split("\n").length - 1 - crlf;
    // Typed or pasted line breaks follow the file's majority line ending.
    if (crlf >= lf) inserted = inserted.replaceAll("\n", "\r\n");
  }
  const from = sourceOffset(source, span.from);
  const to = sourceOffset(source, span.to);
  return source.slice(0, from) + inserted + source.slice(to);
}

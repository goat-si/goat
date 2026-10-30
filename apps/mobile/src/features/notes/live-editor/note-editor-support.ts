import type { NoteEditorChange, NoteLineBreak } from "./note-editor-protocol";

export type NoteEditorSupport =
  | { readonly kind: "live"; readonly lineBreak: NoteLineBreak }
  | { readonly kind: "source"; readonly reason: string };

/**
 * The live editor writes every line break with one separator, so it opens only notes whose
 * breaks it can write back byte for byte.
 */
export function noteEditorSupport(body: string): NoteEditorSupport {
  if (/\r(?!\n)/.test(body))
    return {
      kind: "source",
      reason: "This note uses carriage-return line breaks, so it opens as markdown source.",
    };
  const crlf = body.includes("\r\n");
  if (crlf && /(?:^|[^\r])\n/.test(body))
    return {
      kind: "source",
      reason: "This note mixes Windows and Unix line breaks, so it opens as markdown source.",
    };
  return { kind: "live", lineBreak: crlf ? "\r\n" : "\n" };
}

/** Applies editor changes to the previous string; null means the two copies disagree. */
export function applyNoteEditorChanges(
  body: string,
  changes: ReadonlyArray<NoteEditorChange>,
  length: number,
): string | null {
  let next = body;
  let previousFrom = Number.POSITIVE_INFINITY;
  for (let index = changes.length - 1; index >= 0; index--) {
    const [from, to, insert] = changes[index]!;
    if (!(from >= 0 && from <= to && to <= previousFrom && to <= body.length)) return null;
    next = next.slice(0, from) + insert + next.slice(to);
    previousFrom = from;
  }
  return next.length === length ? next : null;
}

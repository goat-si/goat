import { readComposerDraftSelection } from "./composerDraftSelection";
import type { ComposerDraftInsertion } from "./use-composer-drafts";

export function mapCapturedRange(
  captured: ComposerDraftInsertion,
  text: string,
): { start: number; end: number } | null {
  if (captured.text === text) return captured;
  // A replaced selection is not safe to delete after edits; only a caret follows them.
  if (captured.start !== captured.end) return null;
  const previous = captured.text;
  const shared = Math.min(previous.length, text.length);
  let prefix = 0;
  while (prefix < shared && previous[prefix] === text[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    previous[previous.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  // Text typed at the caret lands after it, so the insertion stays before that text.
  if (captured.start <= prefix) return captured;
  if (captured.start < previous.length - suffix) return null;
  const caret = captured.start + text.length - previous.length;
  return { start: caret, end: caret };
}

/** Keep a caret after the insertion where it was, or the next keystroke lands before typed text. */
export function caretAfterInsertion(
  draftKey: string,
  previousText: string,
  range: { start: number; end: number },
  inserted: number,
): { start: number; end: number } {
  const caret = readComposerDraftSelection(draftKey, previousText);
  if (caret && caret.start > range.end) {
    const delta = range.start + inserted - range.end;
    return { start: caret.start + delta, end: caret.end + delta };
  }
  return { start: range.start + inserted, end: range.start + inserted };
}

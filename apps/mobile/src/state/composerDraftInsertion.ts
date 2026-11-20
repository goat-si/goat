import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@goat/contracts";
import { readComposerDraftSelection } from "./composerDraftSelection";
import type { ComposerDraftInsertion } from "./use-composer-drafts";

function mapTextRange(
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

interface InsertionGroup {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  nextOrder: number;
  completed: Array<{ order: number; text: string; end: number; inserted: string }>;
}
const groups = new WeakMap<object, InsertionGroup>();
const captures = new WeakMap<ComposerDraftInsertion, { group: InsertionGroup; order: number }>();

export function registerComposerDraftInsertion(
  key: object,
  captured: ComposerDraftInsertion,
): ComposerDraftInsertion {
  let group = groups.get(key);
  if (
    !group ||
    group.text !== captured.text ||
    group.start !== captured.start ||
    group.end !== captured.end
  ) {
    group = {
      text: captured.text,
      start: captured.start,
      end: captured.end,
      nextOrder: 0,
      completed: [],
    };
    groups.set(key, group);
  }
  captures.set(captured, { group, order: group.nextOrder++ });
  return captured;
}

export function mapCapturedRange(
  captured: ComposerDraftInsertion,
  text: string,
): { start: number; end: number } | null {
  const mapped = mapTextRange(captured, text);
  const capture = captures.get(captured);
  if (!mapped || !capture || captured.start !== captured.end) return mapped;
  let start = mapped.start;
  for (const prior of capture.group.completed) {
    if (prior.order >= capture.order) continue;
    const end = mapTextRange({ text: prior.text, start: prior.end, end: prior.end }, text)?.start;
    if (end !== undefined && text.slice(end - prior.inserted.length, end) === prior.inserted)
      start = Math.max(start, end);
  }
  return { start, end: start };
}

export function completeComposerDraftInsertion(
  captured: ComposerDraftInsertion | undefined,
  text: string,
  end: number,
  inserted: string,
): void {
  if (!captured) return;
  const capture = captures.get(captured);
  if (!capture) return;
  capture.group.completed.push({ order: capture.order, text, end, inserted });
  if (capture.group.completed.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
    capture.group.completed.shift();
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

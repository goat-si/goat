import { useRef, useState } from "react";
import {
  LIVE_MARKDOWN_MAX_LENGTH,
  applyNoteEditorChange,
  noteEditorChangeIsAmbiguous,
  noteEditorView,
  type NoteEditorSelection,
} from "./note-source-text";

// Backspace reports its cursor move right after the change; a later selection is the user's.
const SETTLE_WINDOW_MS = 250;

type EditorView = { readonly source: string; readonly text: string };
type AmbiguousEdit = {
  readonly source: string;
  readonly previous: string;
  readonly text: string;
  readonly applied: string;
  readonly at: number;
};

/**
 * Keeps the formatted editor's LF text in step with the exact note source. `source` is the
 * screen's latest body, `change` stores a new one, and `tooLarge` runs once an edit passes
 * the size the formatted editor allows.
 */
export function useNoteSourceEditor(
  source: { readonly current: string },
  change: (next: string) => void,
  tooLarge: () => void,
) {
  const [view, setView] = useState<EditorView | null>(null);
  // Change events can arrive before a re-render, as during IME composition.
  const viewRef = useRef<EditorView | null>(null);
  const selection = useRef<NoteEditorSelection | null>(null);
  const ambiguous = useRef<AmbiguousEdit | null>(null);
  const show = (next: EditorView) => {
    viewRef.current = next;
    setView(next);
    change(next.source);
  };
  return {
    value: (body: string) => viewText(view, body),
    onChangeText: (text: string) => {
      const before = source.current;
      const previous = viewText(viewRef.current, before);
      const next = applyNoteEditorChange(before, previous, text, selection.current);
      ambiguous.current = noteEditorChangeIsAmbiguous(before, previous, text, selection.current)
        ? { source: before, previous, text, applied: next, at: Date.now() }
        : null;
      // Pasted CRLF stays out of the view so its offsets keep matching the source.
      show({ source: next, text: text.includes("\r") ? noteEditorView(next) : text });
      if (next.length > LIVE_MARKDOWN_MAX_LENGTH) tooLarge();
    },
    onSelectionChange: (next: NoteEditorSelection) => {
      selection.current = next;
      const pending = ambiguous.current;
      ambiguous.current = null;
      if (
        !pending ||
        source.current !== pending.applied ||
        Date.now() - pending.at > SETTLE_WINDOW_MS
      )
        return;
      const settled = applyNoteEditorChange(
        pending.source,
        pending.previous,
        pending.text,
        next,
        true,
      );
      if (settled !== pending.applied) show({ source: settled, text: pending.text });
    },
  };
}

function viewText(view: EditorView | null, source: string) {
  return view?.source === source ? view.text : noteEditorView(source);
}

import { useRef, useState } from "react";
import {
  LIVE_MARKDOWN_MAX_LENGTH,
  applyNoteEditorChange,
  noteEditorView,
  type NoteEditorSelection,
} from "./note-source-text";

type EditorView = { readonly source: string; readonly text: string };

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
  // React Native reports the Backspace key before the change it makes; forward delete has none.
  const backspace = useRef(false);
  return {
    value: (body: string) => viewText(view, body),
    onKeyPress: (key: string) => {
      backspace.current = key === "Backspace";
    },
    onChangeText: (text: string) => {
      const before = source.current;
      const previous = viewText(viewRef.current, before);
      const next = applyNoteEditorChange(
        before,
        previous,
        text,
        selection.current,
        backspace.current,
      );
      backspace.current = false;
      // Pasted CRLF stays out of the view so its offsets keep matching the source.
      const shown = { source: next, text: text.includes("\r") ? noteEditorView(next) : text };
      viewRef.current = shown;
      setView(shown);
      change(next);
      if (next.length > LIVE_MARKDOWN_MAX_LENGTH) tooLarge();
    },
    onSelectionChange: (next: NoteEditorSelection) => {
      selection.current = next;
    },
  };
}

function viewText(view: EditorView | null, source: string) {
  return view?.source === source ? view.text : noteEditorView(source);
}

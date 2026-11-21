import type { EditorView } from "@tiptap/pm/view";

export function revealComposerCaret(view: EditorView): void {
  const scroller = view.dom;
  const caret = view.coordsAtPos(view.state.selection.head);
  const box = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const bottom = box.bottom - parseFloat(style.paddingBottom);
  const top = box.top + parseFloat(style.paddingTop);
  if (caret.bottom > bottom) scroller.scrollTop += caret.bottom - bottom;
  else if (caret.top < top) scroller.scrollTop -= top - caret.top;
}

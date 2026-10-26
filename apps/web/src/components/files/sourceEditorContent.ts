import { DIFFS_TAG_NAME } from "@pierre/diffs";

const EDITABLE_TEXT = '[role="textbox"][contenteditable="true"]';

/** Pierre renders the editable source text inside its host element's shadow root. */
export function sourceEditorContent(scope: Element): HTMLElement | null {
  for (const host of scope.querySelectorAll(DIFFS_TAG_NAME)) {
    const content = host.shadowRoot?.querySelector<HTMLElement>(EDITABLE_TEXT);
    if (content) return content;
  }
  return null;
}

// Opening another file replaces the viewer's editor with a new instance, so focus waits on
// the view root until that editor attaches. Focus moving anywhere else cancels the wait.
const viewsAwaitingEditor = new WeakSet<Element>();

export function focusViewAwaitingEditor(view: HTMLElement): void {
  viewsAwaitingEditor.add(view);
  view.focus();
}

/** Called when a source editor attaches inside `surface`. */
export function claimAwaitedEditorFocus(surface: Element | null): void {
  const view = surface?.closest("[data-file-view]");
  if (!surface || !view || !viewsAwaitingEditor.delete(view)) return;
  if (document.activeElement === view) sourceEditorContent(surface)?.focus();
}

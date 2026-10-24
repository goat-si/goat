import { DIFFS_TAG_NAME } from "@pierre/diffs";

/** Pierre renders the editable source text inside its host element's shadow root. */
export function sourceEditorContent(view: Element): HTMLElement | null {
  for (const host of view.querySelectorAll(DIFFS_TAG_NAME)) {
    const content = host.shadowRoot?.querySelector<HTMLElement>(
      '[role="textbox"][contenteditable="true"]',
    );
    if (content) return content;
  }
  return null;
}

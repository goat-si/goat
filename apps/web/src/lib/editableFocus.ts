const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/**
 * Focus inside an open shadow root counts: a key event's target is retargeted
 * to the shadow host, so the host's focused descendant is what is typed into.
 */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}

/** A form field has focus: unlike isEditableFocused, a source editor's text does not count. */
export function isTextFieldFocused(target: EventTarget | null = document.activeElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest("input, textarea, select") !== null;
}

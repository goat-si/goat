import type { MouseEvent } from "react";

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/** Includes focused descendants of open shadow roots, whose key events target the host. */
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

// Chromium on Linux pastes PRIMARY into the focused editable unless middle mouseup is cancelled.
export function preventMiddleClickPasteOutsideEditable(event: MouseEvent) {
  if (
    event.button !== 1 ||
    isEditableFocused(event.target) ||
    (event.target instanceof Element && event.target.closest("a[href]"))
  )
    return;
  event.preventDefault();
}

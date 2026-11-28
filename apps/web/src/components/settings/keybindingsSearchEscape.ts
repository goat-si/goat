import type { KeyboardEvent } from "react";

// Esc with a modifier is not a cancel.
export function isBareEscape(event: KeyboardEvent<HTMLInputElement>) {
  return (
    event.key === "Escape" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  );
}

export function handleKeybindingsSearchEscape(
  event: KeyboardEvent<HTMLInputElement>,
  query: string,
  onChange: (next: string) => void,
) {
  if (!isBareEscape(event) || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (query.length > 0 || event.repeat) {
    event.stopPropagation();
    onChange("");
  } else event.currentTarget.blur();
}

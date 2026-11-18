import type { KeyboardEvent } from "react";

export function handleKeybindingsSearchEscape(
  event: KeyboardEvent<HTMLInputElement>,
  query: string,
  onChange: (next: string) => void,
) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (query.length > 0) {
    event.stopPropagation();
    onChange("");
  } else event.currentTarget.blur();
}

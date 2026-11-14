import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { isMacPlatform } from "~/lib/utils";

export function selectRenderedContentOnSelectAll(event: ReactKeyboardEvent<HTMLElement>) {
  const mac = isMacPlatform(navigator.platform);
  const selectAll =
    event.key.toLowerCase() === "a" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.shiftKey &&
    !event.altKey;
  // React bubbles keys from portaled children (the image dialog) through this surface.
  if (
    !selectAll ||
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  event.preventDefault();
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

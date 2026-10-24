import type { ResolvedKeybindingsConfig } from "@goat/contracts";
import { DIFFS_TAG_NAME } from "@pierre/diffs";

import { isFileTreeFocused } from "~/lib/fileViewFocus";

import { fileViewCommandForEvent } from "./fileViewCommands";
import { isPdfFindShortcut } from "./pdf/pdfShortcuts";

/** Pierre renders the editable source text inside its host element's shadow root. */
function sourceEditorContent(view: Element): HTMLElement | null {
  for (const host of view.querySelectorAll(DIFFS_TAG_NAME)) {
    const content = host.shadowRoot?.querySelector<HTMLElement>(
      '[role="textbox"][contenteditable="true"]',
    );
    if (content) return content;
  }
  return null;
}

/**
 * Whether the chat's capture handler must leave this key to the file surface: a
 * focused PDF runs its own find, and so does a file view where files.find is the
 * effective command and something can search (the tree's search field or the
 * source editor). Read-only and rendered views keep thread find.
 */
export function fileSurfaceOwnsFind(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
): boolean {
  if (isPdfFindShortcut(event)) return true;
  if (fileViewCommandForEvent(event, keybindings, ["files.find"]) === null) return false;
  if (isFileTreeFocused(event.target)) return true;
  const view = event.target instanceof Element ? event.target.closest("[data-file-view]") : null;
  return view !== null && sourceEditorContent(view) !== null;
}

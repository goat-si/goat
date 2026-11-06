import { getFilesystemBrowsePath } from "@goat/client-runtime/state/filesystem";
import type { RefObject } from "react";

export interface PendingInputSelection {
  readonly value: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: "forward" | "backward" | "none" | null;
}

export function captureBrowseSelection(
  ref: RefObject<PendingInputSelection | null>,
  source: EventTarget | null,
  nextQuery: string,
  resolvedQuery: string,
  platform: string,
  enabled: boolean,
  isBrowsing: boolean,
) {
  if (
    !(source instanceof HTMLInputElement) ||
    resolvedQuery !== nextQuery ||
    getFilesystemBrowsePath(resolvedQuery, platform, enabled).isBrowsing === isBrowsing
  )
    return;
  ref.current = {
    value: resolvedQuery,
    start: source.selectionStart,
    end: source.selectionEnd,
    direction: source.selectionDirection,
  };
}

export function restoreBrowseSelection(
  input: HTMLInputElement,
  ref?: RefObject<PendingInputSelection | null>,
) {
  const selection = ref?.current;
  if (!ref || !selection) return;
  ref.current = null;
  if (input.value === selection.value)
    input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
}

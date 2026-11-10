import { useEffect } from "react";

import type { CommandPaletteUiAction, SearchOverlayMode } from "./CommandPalette.logic";

/**
 * WebKit reports the Escape that ends an IME composition with keyCode 229 and
 * isComposing already false, so the key that ends composing must not navigate.
 */
export function isComposingEvent(event: {
  readonly isComposing: boolean;
  readonly keyCode: number;
}): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Escape leaves a child search for the command view; a composing Escape only ends the IME. */
export function useChildSearchEscape(
  open: boolean,
  mode: SearchOverlayMode,
  dispatch: (action: CommandPaletteUiAction) => void,
): void {
  // oxlint-disable-next-line goat/react-effect-budget -- the window's keydown listener is outside React
  useEffect(() => {
    if (!open || mode === "command") return;
    const onEscapeKeyDown = (event: KeyboardEvent) => {
      if (isComposingEvent(event) || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ _tag: "BackToCommand" });
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [dispatch, mode, open]);
}

/**
 * What the dialog's own Escape close means inside a child search: keep the
 * dialog open, and go back to the command view unless the key only ended a
 * composition. Anything else is a normal close.
 */
export function childSearchEscape(
  details: { readonly reason: string; readonly event: Event },
  open: boolean,
  mode: string,
): "ignore" | "keep-open" | "back-to-command" {
  if (open || mode === "command" || details.reason !== "escape-key") return "ignore";
  return returnsToCommand(details) ? "back-to-command" : "keep-open";
}

/** The same Escape goes back to the command view unless it only ended a composition. */
export function returnsToCommand(details: { readonly event: Event }): boolean {
  return !(details.event instanceof KeyboardEvent && isComposingEvent(details.event));
}

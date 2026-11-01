import { useEffect } from "react";

import { useSidebar } from "../ui/sidebar";

// One Settings sidebar exists per window. At phone width its search input lives in a sheet that
// is unmounted while closed, so the shortcut records a request that the input completes on mount.
// The shortcut renders beside the sidebar, not above it, so there is no shared provider to hold it.
let searchInput: HTMLInputElement | null = null;
let focusPending = false;

function focusSearch(input: HTMLInputElement) {
  input.focus();
  input.select();
}

/**
 * Ref callback for the Settings search input. Focusing during commit puts focus inside the sheet
 * before its dialog picks an initial focus target, so the dialog keeps it.
 */
export function registerSettingsSearchInput(input: HTMLInputElement | null) {
  searchInput = input;
  if (input && focusPending) {
    focusPending = false;
    focusSearch(input);
  }
}

/** "/" and Mod+F open the Settings sidebar and focus search, even while its phone sheet is closed. */
export function SettingsSearchShortcut() {
  const { isMobile, open, setOpen, setOpenMobile } = useSidebar();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const isFindShortcut =
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey;
      const isSlashShortcut =
        event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFindShortcut && !isSlashShortcut) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        if (
          isSlashShortcut &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        // The phone-width sidebar is itself a sheet dialog; only other overlays block the shortcut.
        const overlay = target.closest(
          '[role="dialog"], [aria-modal="true"], [data-slot$="popup"], [data-keybinding-capture]',
        );
        if (overlay !== null && !overlay.matches('[data-sidebar="sidebar"]')) return;
      }

      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        setOpen(true);
      }
      const input = searchInput;
      if (input) {
        // A collapsed desktop sidebar is inert until its open state commits.
        requestAnimationFrame(() => focusSearch(input));
      } else {
        focusPending = true;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      focusPending = false;
    };
  }, [isMobile, open, setOpen, setOpenMobile]);

  return null;
}

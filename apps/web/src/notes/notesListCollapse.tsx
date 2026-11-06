import type { ResolvedKeybindingsConfig } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { PanelLeftIcon } from "~/components/solar";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { matchesPageCommand, pageCommandShortcutLabel } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isTerminalFocused } from "../lib/terminalFocus";

// A per-browser layout preference; narrow screens keep their own list/detail navigation.
const COLLAPSED_KEY = "goat:notes:list-collapsed";
const WIDE_QUERY = "(min-width: 768px)";
export const NOTES_LIST_ID = "notes-list";
const TOGGLE_ID = "notes-list-toggle";

const useNotesListCollapsed = () => useLocalStorage(COLLAPSED_KEY, false, Schema.Boolean);

export function readNotesListCollapsed(): boolean {
  return readLocalStorageValue(COLLAPSED_KEY, false, Schema.Boolean);
}

export function toggleNotesListCollapsed(): void {
  writeLocalStorageValue(COLLAPSED_KEY, (collapsed: boolean) => !collapsed, false, Schema.Boolean);
}

export function isWideViewport(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}

function subscribeViewport(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The list is hidden by the preference only where the split view shows it. */
export function useNotesListHidden(): boolean {
  const [collapsed] = useNotesListCollapsed();
  const wide = useSyncExternalStore(subscribeViewport, isWideViewport);
  return collapsed && wide;
}

export function focusNotesListToggle(): boolean {
  const toggle = document.getElementById(TOGGLE_ID);
  toggle?.focus();
  return toggle !== null && document.activeElement === toggle;
}

const focusSearch = () => document.querySelector<HTMLInputElement>("[data-notes-search]")?.focus();

export function NotesListToggle(props: { keybindings: ResolvedKeybindingsConfig }) {
  const [collapsed, setCollapsed] = useNotesListCollapsed();
  const shortcut = pageCommandShortcutLabel(props.keybindings, "notes.toggleList", {
    context: { notesPageOpen: true },
  });
  const label = collapsed ? "Show notes list" : "Hide notes list";
  return (
    <div className="max-md:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              id={TOGGLE_ID}
              size="icon-sm"
              variant="ghost-muted"
              aria-label={label}
              aria-expanded={!collapsed}
              aria-controls={NOTES_LIST_ID}
              onClick={() => setCollapsed((value) => !value)}
            />
          }
        >
          <PanelLeftIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label}
          {shortcut ? <Kbd className="ms-2">{shortcut}</Kbd> : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * The toggle shortcut, `/` to search (which reveals a hidden list first), and moving focus off the list
 * when it hides, however it was hidden: the button, the shortcut, the palette, or another tab.
 */
export function useNotesListKeyboard(keybindings: ResolvedKeybindingsConfig): void {
  const hidden = useNotesListHidden();
  const [, setCollapsed] = useNotesListCollapsed();
  // Whether focus sat in the list before anything outside the page, such as the palette, took it.
  const focusWasInList = useRef(false);

  // oxlint-disable-next-line goat/react-effect-budget -- subscribes to window keys and document focus for the page's lifetime.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        matchesPageCommand(event, keybindings, "notes.toggleList", {
          context: {
            terminalFocus: isTerminalFocused(),
            editableFocus: isEditableFocused(event.target),
          },
        })
      ) {
        // On a narrow screen the preference has no visible effect, so leave it alone.
        if (!isWideViewport()) return;
        event.preventDefault();
        event.stopPropagation();
        setCollapsed((value) => !value);
      } else if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isEditableFocused(event.target)
      ) {
        event.preventDefault();
        // Reveal synchronously so search is focusable in the same keystroke.
        if (readNotesListCollapsed() && isWideViewport()) flushSync(() => setCollapsed(false));
        focusSearch();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-command-palette]")) return;
      focusWasInList.current = document.getElementById(NOTES_LIST_ID)?.contains(target) ?? false;
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [keybindings, setCollapsed]);

  // oxlint-disable-next-line goat/react-effect-budget -- the list can hide from another tab or the palette, so focus follows the committed DOM.
  useEffect(() => {
    if (!hidden) return;
    const list = document.getElementById(NOTES_LIST_ID);
    const active = document.activeElement;
    if (!focusWasInList.current && !(active && list?.contains(active))) return;
    const toggle = document.getElementById(TOGGLE_ID);
    // The page is inert while a dialog such as the palette is open; focus once it is usable again.
    const inertHost = toggle?.closest("[inert]");
    if (!toggle || !inertHost) {
      focusNotesListToggle();
      return;
    }
    const observer = new MutationObserver(() => {
      if (inertHost.hasAttribute("inert")) return;
      observer.disconnect();
      if (document.hasFocus()) focusNotesListToggle();
    });
    observer.observe(inertHost, { attributes: true, attributeFilter: ["inert"] });
    // Showing the list again, narrowing the window, or leaving the page cancels the pending focus.
    return () => observer.disconnect();
  }, [hidden]);
}

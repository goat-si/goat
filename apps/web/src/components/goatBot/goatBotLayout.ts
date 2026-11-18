import {
  createContext,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from "react";
import { flushSync } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { useStableCallback } from "~/hooks/useStableCallback";

// The interface font size sets the root size (12-20px), and the composer's controls scale with it
// (about 15rem), so the chat keeps 25rem and its text field about 10rem. Home docks at 22rem.
const CHAT_MIN_REM = 25;
const HOME_DOCKED_REM = 22;

/** True while a task replaces the chat: it stays mounted for its draft but shows nothing. */
export const GoatBotChatHidden = createContext(false);

/**
 * True on the task route, where a task replaces the chat at 980px and below. Home's presentation
 * there never follows the 980px gate: the window query can flip a render before the chat hides.
 */
export const GoatBotChatCanHide = createContext(false);

/** A docked Home's width, from the same constant as the row's reserve and the JS thresholds. */
export const GOAT_BOT_HOME_DOCKED_WIDTH = `${HOME_DOCKED_REM}rem`;

/** The task route's row: a docked Home in the chat leaves the task pane less room. */
export const GOAT_BOT_HOME_RESERVE_ROW_CLASS =
  "has-[[data-goat-bot-home-docked]]:[--goat-bot-home-reserve:var(--goat-bot-home-width)]";

/** The row's style that gives the reserve a docked Home's width. */
export const GOAT_BOT_HOME_RESERVE_ROW_STYLE = {
  "--goat-bot-home-width": GOAT_BOT_HOME_DOCKED_WIDTH,
} as CSSProperties;

/** The task pane's width beside the chat: never the chat's 25rem or a docked Home's room. */
export const GOAT_BOT_TASK_PANE_WIDTH = `min(var(${RESIZABLE_WIDTH_PROPERTY}), calc(100% - ${CHAT_MIN_REM}rem - var(--goat-bot-home-reserve, 0px)))`;

/** Where a docked Home tells the task route's row that it is there. */
export const GoatBotHomeDockedRegistry = createContext<
  (aside: HTMLElement | null) => void | (() => void)
>(() => {});

/** Open state for a popup the chat owns: a task replacing the chat closes it, as unmounting did. */
export function useGoatBotChatPopupOpen() {
  const hidden = useContext(GoatBotChatHidden);
  const [open, setOpen] = useState(false);
  if (hidden && open) setOpen(false);
  return [open && !hidden, setOpen] as const;
}
// GoatBotTaskPane's smallest resizable width, in px as useResizableWidth keeps it.
const TASK_PANE_MIN_WIDTH = 320;
// A modal stays on screen over the task when the chat hides (Home's sheet, Edit bot), so focus in
// one stays; navigationHolds.tsx lists the same slots as modal.
const MODAL_POPUP = ["sheet-popup", "dialog-popup", "alert-dialog-popup", "command-dialog-popup"]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(", ");

/** The window gate keeps every layout as it was at 980px and below; the row decides above it. */
export function goatBotTaskBeside(layout: {
  readonly windowWide: boolean;
  readonly rowWidth: number;
  readonly besideSetting: boolean;
  readonly homeDocked: boolean;
  /** The root font size in px. */
  readonly remPx: number;
}): boolean {
  return (
    layout.besideSetting &&
    layout.windowWide &&
    layout.rowWidth >=
      TASK_PANE_MIN_WIDTH +
        (CHAT_MIN_REM + (layout.homeDocked ? HOME_DOCKED_REM : 0)) * layout.remPx
  );
}

/** Null while the view has no width: hidden, or not laid out yet. */
export function goatBotViewFitsHome(width: number, remPx: number): boolean | null {
  return width > 0 ? width >= (HOME_DOCKED_REM + CHAT_MIN_REM) * remPx : null;
}

/** The root font size in px, which the interface font size sets. */
function rootRemPx(doc: Document): number {
  return Number.parseFloat(getComputedStyle(doc.documentElement).fontSize) || 16;
}

/** Calls back when the root's inline style changes, as a new interface font size does. */
function observeRootStyle(doc: Document, callback: () => void): () => void {
  // Flushed like observeResize's reports, so the decision lands in the frame the CSS cap does.
  const observer = new MutationObserver(() => flushSync(callback));
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
  return () => observer.disconnect();
}

export type GoatBotHomePresentation = "docked" | "sheet" | "unmeasured";

/** How Home opens: docked when the window is wide and the view keeps 752px; null until measured. */
export function goatBotHomeOpenedAs(layout: {
  readonly windowWide: boolean;
  readonly viewFits: boolean | null;
}): "docked" | "sheet" | null {
  if (layout.viewFits === null) return null;
  return layout.windowWide && layout.viewFits ? "docked" : "sheet";
}

/**
 * Measures the bot route's row, where the task pane and the chat sit side by side. Before the
 * chat hides, focus inside it (or already lost to the page) moves to the task heading.
 */
export function useGoatBotTaskBeside(besideSetting: boolean) {
  const [beside, setBeside] = useState(false);
  // What is on screen; the ref callback re-runs when the setting changes and compares against it.
  const shown = useRef(false);
  // React focus events follow the component tree, so a popup the chat portals out (Home's sheet,
  // its model picker) reports here and the task pane's or the command palette's do not.
  const chatFocus = useRef<EventTarget | null>(null);
  // The chat's own modal focus last entered (Home's sheet, Edit bot), the one the watch below tracks.
  const chatModal = useRef<Element | null>(null);
  const onChatFocus = (event: FocusEvent) => {
    chatFocus.current = event.target;
    chatModal.current = event.target instanceof Element ? event.target.closest(MODAL_POPUP) : null;
  };
  const handOffFocus = useStableCallback((row: HTMLElement) => {
    const active = row.ownerDocument.activeElement;
    const lost = active === null || active === row.ownerDocument.body;
    if (!lost && active !== chatFocus.current) return;
    if (active?.closest(MODAL_POPUP)) return;
    row.querySelector<HTMLElement>("[data-goat-bot-task-heading]")?.focus();
  });
  // While the task replaces the chat, the chat's modal closing returns focus to a hidden trigger,
  // which drops it to the page; the task heading takes it. Base UI portals popups into children of
  // <body>, so only that list is watched, only meanwhile; other modals and tooltips are left alone.
  const rowElement = useRef<HTMLElement | null>(null);
  const watchModalClose = (chat: HTMLElement | null) => {
    if (chat === null) return;
    const doc = chat.ownerDocument;
    // A modal that closed while the chat was shown is no longer the chat's to watch.
    if (chatModal.current?.isConnected === false) chatModal.current = null;
    const observer = new MutationObserver(() => {
      const modal = chatModal.current;
      if (modal === null || modal.isConnected) return;
      chatModal.current = null;
      const active = doc.activeElement;
      if (active === null || active === doc.body)
        rowElement.current?.querySelector<HTMLElement>("[data-goat-bot-task-heading]")?.focus();
    });
    observer.observe(doc.body, { childList: true });
    return () => observer.disconnect();
  };
  // The docked Home registers itself, so its mount or unmount decides again without a resize; a
  // DOM read in its ref cleanup would still find it, since React detaches refs before removal.
  const dockedHome = useRef<HTMLElement | null>(null);
  const remeasure = useRef(() => {});
  const registerHomeDocked = (aside: HTMLElement | null) => {
    if (aside === null) return;
    dockedHome.current = aside;
    remeasure.current();
    return () => {
      if (dockedHome.current === aside) dockedHome.current = null;
      remeasure.current();
    };
  };
  const rowRef = (row: HTMLElement | null) => {
    if (row === null) return;
    rowElement.current = row;
    const windowQuery = window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
    const measure = () => {
      if (!row.isConnected) return;
      const next = goatBotTaskBeside({
        windowWide: !windowQuery.matches,
        rowWidth: row.getBoundingClientRect().width,
        besideSetting,
        homeDocked: dockedHome.current !== null,
        remPx: rootRemPx(row.ownerDocument),
      });
      if (next === shown.current) return;
      if (!next) handOffFocus(row);
      shown.current = next;
      setBeside(next);
    };
    measure();
    remeasure.current = measure;
    windowQuery.addEventListener("change", measure);
    const stopObserving = observeResize(row, measure);
    const stopRoot = observeRootStyle(row.ownerDocument, measure);
    return () => {
      remeasure.current = () => {};
      windowQuery.removeEventListener("change", measure);
      stopObserving();
      stopRoot();
    };
  };
  return { beside, rowRef, onChatFocus, watchModalClose, registerHomeDocked };
}

/**
 * Measures the chat view, which a docked Home shares. Home keeps the presentation it opened in
 * until it closes; only dev's 980px gate chooses again, on a chat a task cannot hide.
 */
export function useGoatBotHomePresentation(panelOpen: boolean) {
  const hidden = useContext(GoatBotChatHidden);
  const canHide = useContext(GoatBotChatCanHide);
  const windowWide = !useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [viewFits, setViewFits] = useState<boolean | null>(null);
  // A closed Home keeps its last presentation, so the sheet's closing animation and focus run.
  const [choice, setChoice] = useState<{ live: boolean; wide: boolean; docked: boolean } | null>(
    null,
  );
  let next = choice;
  if (!panelOpen) {
    if (choice?.live) next = { ...choice, live: false };
  } else if (choice === null || !choice.live || (!canHide && choice.wide !== windowWide)) {
    const openedAs = goatBotHomeOpenedAs({ windowWide, viewFits });
    if (openedAs !== null) next = { live: true, wide: windowWide, docked: openedAs === "docked" };
  }
  if (next !== choice) setChoice(next);
  const viewRef = (view: HTMLElement | null) => {
    if (view === null) return;
    const measure = () =>
      setViewFits(
        goatBotViewFitsHome(view.getBoundingClientRect().width, rootRemPx(view.ownerDocument)),
      );
    measure();
    const stopObserving = observeResize(view, measure);
    const stopRoot = observeRootStyle(view.ownerDocument, measure);
    return () => {
      stopObserving();
      stopRoot();
    };
  };
  const presentation: GoatBotHomePresentation =
    next === null ? "unmeasured" : next.docked ? "docked" : "sheet";
  return { viewRef, presentation, hidden };
}

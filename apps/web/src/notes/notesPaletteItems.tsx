import { FileTextIcon, PanelLeftIcon, SquarePenIcon } from "~/components/solar";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import {
  isWideViewport,
  readNotesListCollapsed,
  toggleNotesListCollapsed,
} from "./notesListCollapse";
import { isNotesPageOpen } from "./notesPageVisibility";

/** The palette's Notes entries; New note opens the Notes page, which creates and focuses it. */
export function notesPaletteItems(
  navigate: (to: { to: "/notes"; search: { create?: true } }) => Promise<void>,
  canCreateNote: boolean,
): CommandPaletteActionItem[] {
  const open: CommandPaletteActionItem = {
    kind: "action",
    value: "action:notes",
    searchTerms: ["notes", "markdown", "ideas", "notebook"],
    title: "Open notes",
    icon: <FileTextIcon className={ITEM_ICON_CLASS} />,
    run: () => navigate({ to: "/notes", search: {} }),
  };
  const items = [open];
  if (canCreateNote)
    items.push({
      kind: "action",
      value: "action:new-note",
      searchTerms: ["new note", "create note", "idea", "markdown"],
      title: "New note",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: () => navigate({ to: "/notes", search: { create: true } }),
    });
  // Only where the list can be seen hiding: on the Notes page, wide enough for the split view.
  // It never navigates, so the open note stays open.
  if (isNotesPageOpen() && isWideViewport())
    items.push({
      kind: "action",
      value: "action:notes-toggle-list",
      searchTerms: ["notes list", "hide notes", "show notes", "sidebar", "collapse"],
      title: readNotesListCollapsed() ? "Show notes list" : "Hide notes list",
      icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "notes.toggleList",
      run: async () => toggleNotesListCollapsed(),
    });
  return items;
}

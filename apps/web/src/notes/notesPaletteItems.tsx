import { FileTextIcon, SquarePenIcon } from "~/components/solar";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";

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
  if (!canCreateNote) return [open];
  return [
    open,
    {
      kind: "action",
      value: "action:new-note",
      searchTerms: ["new note", "create note", "idea", "markdown"],
      title: "New note",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: () => navigate({ to: "/notes", search: { create: true } }),
    },
  ];
}

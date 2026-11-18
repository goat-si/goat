import { TextSearchIcon } from "./solar";
import { openThreadFind } from "./chat/threadFindStore";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

export function appendFindItems(
  actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem>,
  activeThreadKey: string | null,
  activeThreadCanFind: boolean,
) {
  if (activeThreadKey !== null && activeThreadCanFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current thread",
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        openThreadFind(activeThreadKey);
      },
    });
  }
}

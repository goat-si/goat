import { dispatchPreviewAction } from "./preview/previewActionBus";
import { previewBridge } from "./preview/previewBridge";
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
  previewOpen: boolean,
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

  if (previewOpen && previewBridge?.findInPage) {
    actionItems.push({
      kind: "action",
      value: "find-in-browser-page",
      title: "Find in browser page",
      searchTerms: ["find", "search", "browser", "page"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "preview.find",
      run: async () => dispatchPreviewAction("find"),
    });
  }
}

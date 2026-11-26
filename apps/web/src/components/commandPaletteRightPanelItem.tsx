import { dispatchPanelMenuAction } from "~/lib/panelMenuActions";
import { PanelRightIcon } from "./solar";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

/** The thread's right panel toggle, for whichever thread view is in front (chat or GOAT Bot). */
export function rightPanelPaletteItems(threadShown: boolean): CommandPaletteActionItem[] {
  if (!threadShown) return [];
  return [
    {
      kind: "action",
      value: "action:toggle-right-panel",
      title: "Toggle right panel",
      searchTerms: ["right panel", "panel", "browser", "terminal", "device"],
      icon: <PanelRightIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "rightPanel.toggle",
      run: async () => dispatchPanelMenuAction("rightPanel.toggle"),
    },
  ];
}

import { useLocation, useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { createElement } from "react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { SettingsIcon } from "./solar";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";

const NO_SETTINGS_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];
const settingsPaletteIcon = createElement(SettingsIcon, { className: ITEM_ICON_CLASS });

/**
 * Every setting as a palette row, so settings get the palette's word starts and typo
 * tolerance. Its own hook so the compiler keeps the rows across keystrokes. Only a search
 * lists settings, so opening the palette does not translate them.
 */
export function useCommandPaletteSettingsItems(
  searching: boolean,
): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  if (!searching) return NO_SETTINGS_ITEMS;
  return settingsForThisPlatform(availableSettingsSearchItems).map((item) => {
    const sourceSection = SETTINGS_SECTION_LABELS[item.to];
    const title = m(item.title);
    const section = m(sourceSection);
    const names = title === item.title ? [title] : [title, item.title];
    const keywords = [section, sourceSection, ...(item.searchTerms ?? [])].filter(
      (term) => term.length > 0 && !names.includes(term),
    );
    return {
      kind: "action",
      value: `setting:${item.id}`,
      searchTerms: [...names, ...new Set(keywords)],
      ...(names.length > 1 ? { searchNameCount: names.length } : {}),
      title,
      description: gt("Settings · {section}", { section }),
      ...(item.secondary ? { secondary: true } : {}),
      icon: settingsPaletteIcon,
      run: async () => {
        await navigate({
          to: item.to,
          hash: item.targetId ?? item.id,
          replace: pathname === item.to,
          hashScrollIntoView: false,
        });
      },
    };
  });
}

import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";

import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import {
  settingsForThisPlatform,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "./settings/settingsSearch";

export function useCommandPaletteSettingsItems(
  availableSettingsSearchItems: ReadonlyArray<SettingsSearchItem>,
  pathname: string,
  icon: ReactNode,
): CommandPaletteActionItem[] {
  const gt = useGT();
  const m = useMessages();
  const navigate = useNavigate();
  // Settings use the same word-start and typo matching as threads.
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
      icon,
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

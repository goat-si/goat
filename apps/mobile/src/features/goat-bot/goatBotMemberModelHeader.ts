import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import type { MobileGoatBotMemberModelMenu } from "./useMobileGoatBotMemberModel";

/** The member's model as an iOS header menu, labelled with the model it uses. */
export function goatBotMemberModelHeaderItem(menu: MobileGoatBotMemberModelMenu) {
  return withNativeGlassHeaderItem({
    accessibilityLabel: menu.accessibilityLabel,
    identifier: "goat-bot-member-model",
    label: menu.label,
    type: "menu" as const,
    menu: {
      title: menu.title,
      items: menu.items.map((item) => ({
        type: "action" as const,
        label: item.title,
        description: item.subtitle,
        state: item.selected ? ("on" as const) : ("off" as const),
        disabled: !menu.canChange,
        onPress: () => menu.select(item.id),
      })),
    },
  });
}

/** Changes when anything the header item shows changes, for the native header's options version. */
export function goatBotMemberModelHeaderKey(menu: MobileGoatBotMemberModelMenu | null) {
  if (menu === null) return "";
  const selected = menu.items.find((item) => item.selected)?.id ?? "";
  return `${menu.label}:${selected}:${menu.canChange}:${menu.items.length}`;
}

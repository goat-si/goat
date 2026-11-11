import type { MenuAction } from "@react-native-menu/menu";
import { Pressable, Text } from "react-native";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import type { MobileGoatBotMemberModelMenu } from "./useMobileGoatBotMemberModel";

/** Android's member model menu, beside Work above the chat. */
export function GoatBotMemberModelAndroidMenu({
  menu,
}: {
  readonly menu: MobileGoatBotMemberModelMenu;
}) {
  const actions: MenuAction[] = menu.items.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    state: item.selected ? "on" : "off",
    attributes: { disabled: !menu.canChange },
  }));
  return (
    <AndroidAnchoredMenu
      title={menu.title}
      actions={actions}
      onPressAction={({ nativeEvent }) => menu.select(nativeEvent.event)}
    >
      {(open) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={menu.accessibilityLabel}
          onPress={open}
          className="min-h-[44px] shrink justify-center px-4 py-2"
        >
          <Text numberOfLines={1} className="text-foreground-muted">
            {menu.label}
          </Text>
        </Pressable>
      )}
    </AndroidAnchoredMenu>
  );
}

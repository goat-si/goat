import type { MenuAction } from "@react-native-menu/menu";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import type { useMobileGoatBotModelMenu } from "./useMobileGoatBotModel";

type GoatBotModelMenu = NonNullable<ReturnType<typeof useMobileGoatBotModelMenu>>;

/** Android's GOAT Bot header model menu; iOS builds the same items into its native toolbar. */
export function GoatBotModelAndroidMenu({ menu }: { readonly menu: GoatBotModelMenu }) {
  const actions: MenuAction[] = menu.items.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    state: item.selected ? "on" : "off",
  }));
  return (
    <AndroidAnchoredMenu
      title={menu.accessibilityLabel}
      actions={actions}
      onPressAction={({ nativeEvent }) => menu.select(nativeEvent.event)}
    >
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel={menu.accessibilityLabel}
          icon="sparkles"
          disabled={menu.disabled}
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  );
}

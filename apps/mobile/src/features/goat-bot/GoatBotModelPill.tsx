import type { MenuAction } from "@react-native-menu/menu";
import { Platform, Pressable, Text, View } from "react-native";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { GoatBotModelPillMenu } from "./goatBotModelPillMenu";

// The pill sits between "+" and Send; its menu wrapper must give way so a long name truncates.
const SHRINK = { flexShrink: 1, minWidth: 0 } as const;

/** The composer's model pill, which opens the model menu in place of the old header item. */
export function GoatBotModelPill(props: { readonly menu: GoatBotModelPillMenu }) {
  const { menu } = props;
  const label = useScaledTextRole("label");
  const actions: MenuAction[] = menu.items.map((item) => ({
    id: item.id,
    title: item.title,
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    state: item.selected ? "on" : "off",
    attributes: { disabled: !menu.canChange },
  }));
  const pill = (onPress?: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={menu.accessibilityLabel}
      accessibilityHint="Chooses the model"
      accessibilityState={{ disabled: !menu.opens }}
      disabled={!menu.opens}
      onPress={onPress}
      className="min-h-[44px] shrink justify-center"
      style={menu.opens ? undefined : { opacity: 0.5 }}
    >
      <View className="shrink flex-row items-center gap-1 rounded-full border border-border px-3 py-1">
        <Text numberOfLines={1} className="shrink text-foreground-muted" style={label}>
          {menu.label}
        </Text>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
      </View>
    </Pressable>
  );
  if (!menu.opens) return pill();
  if (Platform.OS === "android") {
    return (
      <AndroidAnchoredMenu
        style={SHRINK}
        title={menu.title}
        actions={actions}
        onPressAction={({ nativeEvent }) => menu.select(nativeEvent.event)}
      >
        {(open) => pill(open)}
      </AndroidAnchoredMenu>
    );
  }
  return (
    <Menu
      style={SHRINK}
      title={menu.title}
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => menu.select(nativeEvent.event)}
    >
      {pill()}
    </Menu>
  );
}

import { MenuView, type MenuAction, type MenuComponentRef } from "@react-native-menu/menu";
import { useRef } from "react";
import { Platform, Text, View } from "react-native";

import { Menu } from "../../components/ui/Menu";

/**
 * A Work row's actions in a native menu with every choice (Android's Alert keeps three). In the
 * Home sheet's modal, Android uses the native menu view, since the anchored menu draws behind it;
 * that view opens on touch only, so a screen reader's activation opens it through its ref.
 */
export function MobileBotRowMenu(props: {
  readonly label: string;
  readonly title: string;
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  const menuRef = useRef<MenuComponentRef>(null);
  const android = Platform.OS === "android";
  const control = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.label}
      {...(android
        ? {
            accessibilityActions: [{ name: "activate" }],
            onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === "activate") menuRef.current?.show();
            },
          }
        : {})}
      className="h-11 w-11 items-center justify-center"
    >
      <Text className="text-foreground-muted">…</Text>
    </View>
  );
  const select = ({ nativeEvent }: { nativeEvent: { event: string } }) =>
    props.onSelect(nativeEvent.event);
  if (android)
    return (
      <MenuView
        ref={menuRef}
        title={props.title}
        actions={[...props.actions]}
        shouldOpenOnLongPress={false}
        onPressAction={select}
      >
        {control}
      </MenuView>
    );
  return (
    <Menu
      title={props.title}
      actions={[...props.actions]}
      shouldOpenOnLongPress={false}
      onPressAction={select}
    >
      {control}
    </Menu>
  );
}

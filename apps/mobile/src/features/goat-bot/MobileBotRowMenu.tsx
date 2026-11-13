import { MenuView, type MenuAction, type MenuComponentRef } from "@react-native-menu/menu";
import { useRef, type ReactElement } from "react";
import { Platform, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { Menu } from "../../components/ui/Menu";

/**
 * A Work row's actions in a native menu with every choice (Android's Alert keeps three). In the
 * Home sheet's modal, Android uses the native menu view, since the anchored menu draws behind it;
 * that view opens on touch only, so a screen reader's activation opens it through its ref.
 * Given a row as children, the same menu opens on a long press of that row instead.
 */
export function MobileBotRowMenu(props: {
  readonly label: string;
  readonly title: string;
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly children?: ReactElement;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const menuRef = useRef<MenuComponentRef>(null);
  const android = Platform.OS === "android";
  const control = props.children ?? (
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
  const longPress = props.children !== undefined;
  if (android)
    return (
      <MenuView
        ref={menuRef}
        title={props.title}
        style={props.style}
        actions={[...props.actions]}
        shouldOpenOnLongPress={longPress}
        onPressAction={select}
      >
        {control}
      </MenuView>
    );
  return (
    <Menu
      title={props.title}
      style={props.style}
      actions={[...props.actions]}
      shouldOpenOnLongPress={longPress}
      onPressAction={select}
    >
      {control}
    </Menu>
  );
}

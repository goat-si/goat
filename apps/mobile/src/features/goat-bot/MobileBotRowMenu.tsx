import { MenuView, type MenuAction, type MenuComponentRef } from "@react-native-menu/menu";
import { cloneElement, useRef, type ReactElement } from "react";
import { Platform, Text, View, type PressableProps } from "react-native";

import { Menu } from "../../components/ui/Menu";

type LongPressable = ReactElement<Pick<PressableProps, "onLongPress">>;

function WithLongPress(props: {
  readonly children: LongPressable;
  readonly onLongPress: () => void;
}) {
  return cloneElement(props.children, { onLongPress: props.onLongPress });
}

/**
 * A Work row's actions with every choice. Android uses the native menu view (the anchored menu
 * draws behind the Home modal); it takes every touch of what it wraps and opens on touch only, so
 * TalkBack and a long press of the row open it through its ref, and the row stays outside it.
 */
export function MobileBotRowMenu(props: {
  readonly label: string;
  readonly title: string;
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly row?: LongPressable;
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
  const button = android ? (
    <MenuView
      ref={menuRef}
      title={props.title}
      actions={[...props.actions]}
      shouldOpenOnLongPress={false}
      onPressAction={select}
    >
      {control}
    </MenuView>
  ) : (
    <Menu
      title={props.title}
      actions={[...props.actions]}
      shouldOpenOnLongPress={false}
      onPressAction={select}
    >
      {control}
    </Menu>
  );
  if (!props.row) return button;
  const row = android ? (
    <WithLongPress onLongPress={() => menuRef.current?.show()}>{props.row}</WithLongPress>
  ) : (
    <Menu
      title={props.title}
      style={{ flex: 1 }}
      actions={[...props.actions]}
      shouldOpenOnLongPress
      onPressAction={select}
    >
      {props.row}
    </Menu>
  );
  return (
    <View className="flex-row items-center">
      {row}
      {button}
    </View>
  );
}

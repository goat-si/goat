import type { MenuAction } from "@react-native-menu/menu";
import { Platform, Pressable, Text } from "react-native";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";

/**
 * A Work row's actions in a native menu, which shows every choice on both platforms; Android's
 * Alert keeps only three buttons and cannot be dismissed by default.
 */
export function MobileBotRowMenu(props: {
  readonly label: string;
  readonly title: string;
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  const button = (onPress?: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={onPress}
      className="h-11 w-11 items-center justify-center"
    >
      <Text className="text-foreground-muted">…</Text>
    </Pressable>
  );
  if (Platform.OS === "android")
    return (
      <AndroidAnchoredMenu
        title={props.title}
        actions={props.actions}
        onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
      >
        {(open) => button(open)}
      </AndroidAnchoredMenu>
    );
  return (
    <Menu
      title={props.title}
      actions={[...props.actions]}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      {button()}
    </Menu>
  );
}

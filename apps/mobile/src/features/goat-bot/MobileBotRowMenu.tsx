import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { Platform, Text, View } from "react-native";

import { Menu } from "../../components/ui/Menu";

/**
 * A Work row's actions in a native menu, which shows every choice on both platforms (Android's
 * Alert keeps only three). The row lives in the Home sheet's modal, and Android's anchored menu
 * draws in the app-root portal behind it, so Android uses the native menu view, as
 * MediaActionsMenu does in a modal.
 */
export function MobileBotRowMenu(props: {
  readonly label: string;
  readonly title: string;
  readonly actions: readonly MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  const RowMenu = Platform.OS === "android" ? MenuView : Menu;
  return (
    <RowMenu
      title={props.title}
      actions={[...props.actions]}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={props.label}
        className="h-11 w-11 items-center justify-center"
      >
        <Text className="text-foreground-muted">…</Text>
      </View>
    </RowMenu>
  );
}

import { View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * Centers in the area the composer and keyboard leave visible. The list insets itself for the
 * keyboard, but this sits over it, so it adds the keyboard height to the composer's inset.
 */
export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  const keyboardHeight = useKeyboardState((state) => state.height);
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset + keyboardHeight,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-goat-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

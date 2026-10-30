import { View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * Centers in the area the composer leaves visible. It sits over the list, which insets itself for
 * the keyboard, so it follows the composer's keyboard lift: half of it keeps the text centered.
 */
export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly keyboardLift?: SharedValue<number>;
  readonly title: string;
  readonly topInset: number;
}) {
  const { keyboardLift } = props;
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -(keyboardLift?.value ?? 0) / 2 }],
  }));
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <Animated.View className="max-w-[320px] items-center gap-2" style={liftStyle}>
        <Text className="text-center font-goat-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </Animated.View>
    </View>
  );
}

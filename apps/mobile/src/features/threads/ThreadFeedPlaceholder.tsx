import { View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * Fills the area between the header and the composer, following the composer's keyboard lift,
 * and clips text taller than that area rather than drawing it under the composer or header.
 */
export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly keyboardLift?: SharedValue<number>;
  readonly title: string;
  readonly topInset: number;
}) {
  const { bottomInset, keyboardLift } = props;
  const areaStyle = useAnimatedStyle(() => ({
    paddingBottom: bottomInset + (keyboardLift?.value ?? 0),
  }));
  return (
    <Animated.View
      style={[
        {
          flex: 1,
          flexGrow: 1,
          paddingTop: props.topInset,
          paddingHorizontal: props.horizontalPadding + 24,
        },
        areaStyle,
      ]}
    >
      <View className="flex-1 items-center justify-center overflow-hidden">
        <View className="max-w-[320px] items-center gap-2">
          <Text className="text-center font-goat-bold text-lg text-foreground">{props.title}</Text>
          <Text className="text-center text-sm leading-normal text-foreground-secondary">
            {props.detail}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

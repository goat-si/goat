import { Platform } from "react-native";
import { useAnimatedStyle, type SharedValue } from "react-native-reanimated";

export function useAndroidContentStyles(
  usesSplitView: boolean,
  renderedContentWidth: SharedValue<number>,
  contentTargetWidth: number | null,
) {
  const androidSplit = Platform.OS === "android" && usesSplitView;
  const androidContentSlotStyle = useAnimatedStyle(() => ({
    width: androidSplit ? renderedContentWidth.value : ("100%" as const),
  }));
  const androidNavigatorLimit = useAnimatedStyle(() => ({
    maxWidth:
      androidSplit && contentTargetWidth !== null && renderedContentWidth.value < contentTargetWidth
        ? contentTargetWidth
        : ("100%" as const),
  }));
  return { androidContentSlotStyle, androidNavigatorLimit };
}

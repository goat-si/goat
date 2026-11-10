import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useId, useState } from "react";
import { Animated, StyleSheet, Text, View, useAnimatedValue, type TextStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import { startShimmerSteps } from "../threads/work-shimmer-steps";

const BAND_WIDTH = 72;

/**
 * One line of muted text with the work log's stepped highlight passing over it while `animate`
 * holds and motion is allowed. The band moves in discrete steps with long still pauses, never a
 * per-frame repaint, and stops under Reduce Motion, in the background and off the focused screen.
 */
export function GoatBotShimmerText(props: {
  readonly label: string;
  readonly animate: boolean;
  readonly style?: TextStyle;
}) {
  const appActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const focused = useIsFocused();
  const [width, setWidth] = useState(0);
  const progress = useAnimatedValue(0, { useNativeDriver: true });
  const gradientId = `goat-bot-shimmer-${useId().replaceAll(":", "")}`;
  const moving = props.animate && appActive && !reducedMotion && focused;
  // oxlint-disable-next-line goat/react-effect-budget -- runs the stepped highlight while the line may animate
  useEffect(() => {
    progress.setValue(0);
    if (!moving) return;
    return startShimmerSteps(progress);
  }, [moving, progress]);
  const sweep = progress.interpolate({ inputRange: [0, 1], outputRange: [-BAND_WIDTH, width] });
  const counterSweep = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [BAND_WIDTH, -width],
  });
  return (
    <View
      className="min-w-0 flex-1 overflow-hidden"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Text numberOfLines={1} className="text-foreground-muted" style={props.style}>
        {props.label}
      </Text>
      {moving ? (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: BAND_WIDTH,
            overflow: "hidden",
            transform: [{ translateX: sweep }],
          }}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <Animated.View style={{ width, transform: [{ translateX: counterSweep }] }}>
              <Text numberOfLines={1} className="text-foreground" style={props.style}>
                {props.label}
              </Text>
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

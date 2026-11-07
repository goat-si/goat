import {
  FACE_MOTION_RANK,
  GOAT_BOT_FACE_STROKE_WIDTH,
  GOAT_BOT_SLEEP_MARK_PATH,
  goatBotFaceArt,
  goatBotFaceLabel,
  type FaceMotion,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_VIEWBOX,
} from "@goat/shared/goatMark";
import { useCallback, useEffect, useState } from "react";
import {
  Animated as NativeAnimated,
  Easing,
  StyleSheet,
  Text,
  View,
  useAnimatedValue,
} from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useMobileGoatBotFace, useMobileGoatBotFaceMotion } from "./useMobileGoatBotFace";

const ThemedPath = withUniwind(Path);
const FACE_ENTERING = FadeIn.duration(150).reduceMotion(ReduceMotion.System);
const INK = "accent-icon";
/** The face spans 20 grid units of the mark's viewBox. */
const FACE_UNITS = 20;
const STILL_FRAMES = [
  { at: 0, x: 0, scaleY: 1 },
  { at: 1, x: 0, scaleY: 1 },
] as const;

/**
 * The goat mark's horns over a pair of eyes that show what the bot is doing. The eyes are their
 * own view, so a moving face loops only that view's transform on React Native's native driver
 * (Reanimated's per-frame commits starve React's here; see docs/internals/performance-regressions.md).
 */
export function GoatBotFace(props: {
  readonly state: GoatBotFaceState;
  readonly size: number;
  /** The eye motion this face runs now; null holds it still. */
  readonly motion?: FaceMotion | null;
}) {
  // Fade only on a change, never when the face first appears.
  const [firstState] = useState(props.state);
  const [changed, setChanged] = useState(false);
  if (!changed && props.state !== firstState) setChanged(true);
  const art = goatBotFaceArt(props.state);
  const motion = props.motion ?? null;
  const progress = useAnimatedValue(0);
  // oxlint-disable-next-line goat/react-effect-budget -- drives the eyes' native-driver loop while this face holds the motion
  useEffect(() => {
    progress.setValue(0);
    if (motion === null) return;
    const loop = NativeAnimated.loop(
      NativeAnimated.timing(progress, {
        toValue: 1,
        duration: motion.cycleMs,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, progress]);
  const frames = motion?.frames ?? STILL_FRAMES;
  const inputRange = frames.map((frame) => frame.at);
  const translateX = progress.interpolate({
    inputRange,
    outputRange: frames.map((frame) => (frame.x * props.size) / FACE_UNITS),
  });
  const scaleY = progress.interpolate({
    inputRange,
    outputRange: frames.map((frame) => frame.scaleY),
  });
  return (
    <Animated.View key={props.state} entering={changed ? FACE_ENTERING : undefined}>
      <View style={{ width: props.size, height: props.size }}>
        <Svg
          style={StyleSheet.absoluteFill}
          width={props.size}
          height={props.size}
          viewBox={GOAT_MARK_VIEWBOX}
        >
          <ThemedPath
            d={GOAT_MARK_HORNS_PATH}
            colorClassName={INK}
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
            strokeLinejoin="round"
          />
          {art.sleepMark ? (
            <ThemedPath
              d={GOAT_BOT_SLEEP_MARK_PATH}
              colorClassName={INK}
              fill="none"
              stroke="currentColor"
              strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </Svg>
        {/* The eyes sit at 67% of the face's height; a blink scales around them. */}
        <NativeAnimated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { transformOrigin: "50% 67%", transform: [{ translateX }, { scaleY }] },
          ]}
        >
          <Svg width={props.size} height={props.size} viewBox={GOAT_MARK_VIEWBOX}>
            {art.stroked ? (
              <ThemedPath
                d={art.eyes}
                colorClassName={INK}
                fill="none"
                stroke="currentColor"
                strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
                strokeLinecap="round"
              />
            ) : (
              <ThemedPath d={art.eyes} colorClassName={INK} fill="currentColor" />
            )}
          </Svg>
        </NativeAnimated.View>
      </View>
    </Animated.View>
  );
}

const RING: Partial<Record<GoatBotFaceState, string>> = {
  working: "border-primary",
  failed: "border-danger",
};

/** The face on the bot's round avatar; callers put the face label in their own row label. */
export function GoatBotFaceAvatar(props: {
  readonly state: GoatBotFaceState;
  readonly size: number;
  readonly motion?: FaceMotion | null;
}) {
  return (
    <View
      style={{ width: props.size, height: props.size }}
      className={`items-center justify-center rounded-full border bg-grouped-card ${RING[props.state] ?? "border-transparent"}`}
    >
      <GoatBotFace state={props.state} size={props.size * 0.64} motion={props.motion ?? null} />
      {props.state === "waiting" ? (
        <View className="absolute top-0 right-0 h-2.5 w-2.5 rounded-full bg-warning" />
      ) : null}
    </View>
  );
}

function GoatBotHeaderTitle(props: {
  readonly state: GoatBotFaceState;
  readonly motion: FaceMotion | null;
  readonly title: string;
}) {
  const label = goatBotFaceLabel(props.state);
  const accessibilityLabel = label ? `${props.title}, ${label}` : props.title;
  return (
    // Unflattened so the text swap below stays in this row and leaves the native title view alone.
    <View collapsable={false} className="flex-row items-center gap-2">
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <GoatBotFaceAvatar state={props.state} size={28} motion={props.motion} />
      </View>
      {/* VoiceOver reads the text element here, and iOS keeps a text's first label until its text
          changes; a new key gives each state a fresh element instead of a stale second one. */}
      <Text
        key={accessibilityLabel}
        accessibilityRole="header"
        accessibilityLabel={accessibilityLabel}
        className="text-base font-semibold text-foreground"
      >
        {props.title}
      </Text>
    </View>
  );
}

/** Puts the main bot's face in the native header title (iOS; Android hides this header). */
export function GoatBotHeaderFace(props: {
  readonly activity: GoatBotFaceInput["activity"];
  readonly title: string;
}) {
  const face = useMobileGoatBotFace(props.activity);
  // The header shows whenever its screen is focused, which the motion hook already checks.
  const motion = useMobileGoatBotFaceMotion(face.state, FACE_MOTION_RANK.header, face.since, true);
  const { state } = face;
  const title = props.title;
  const renderTitle = useCallback(
    () => <GoatBotHeaderTitle state={state} motion={motion} title={title} />,
    [state, motion, title],
  );
  return (
    <NativeStackScreenOptions
      options={{ headerTitle: renderTitle }}
      optionsVersion={`${state}:${motion === null ? "still" : "moving"}`}
    />
  );
}

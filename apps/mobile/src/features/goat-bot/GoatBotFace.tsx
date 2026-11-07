import {
  GOAT_BOT_FACE_STROKE_WIDTH,
  GOAT_BOT_SLEEP_MARK_PATH,
  goatBotFaceArt,
  goatBotFaceLabel,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_VIEWBOX,
} from "@goat/shared/goatMark";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useMobileGoatBotFace } from "./useMobileGoatBotFace";

const ThemedPath = withUniwind(Path);
const FACE_ENTERING = FadeIn.duration(150).reduceMotion(ReduceMotion.System);
const INK = "accent-icon";

/** The goat mark's horns over a pair of eyes that show what the bot is doing. */
export function GoatBotFace(props: { readonly state: GoatBotFaceState; readonly size: number }) {
  // Fade only on a change, never when the face first appears.
  const [firstState] = useState(props.state);
  const [changed, setChanged] = useState(false);
  if (!changed && props.state !== firstState) setChanged(true);
  const art = goatBotFaceArt(props.state);
  return (
    <Animated.View key={props.state} entering={changed ? FACE_ENTERING : undefined}>
      <Svg width={props.size} height={props.size} viewBox={GOAT_MARK_VIEWBOX}>
        <ThemedPath
          d={GOAT_MARK_HORNS_PATH}
          colorClassName={INK}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
          strokeLinejoin="round"
        />
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
}) {
  return (
    <View
      style={{ width: props.size, height: props.size }}
      className={`items-center justify-center rounded-full border bg-grouped-card ${RING[props.state] ?? "border-transparent"}`}
    >
      <GoatBotFace state={props.state} size={props.size * 0.64} />
      {props.state === "waiting" ? (
        <View className="absolute top-0 right-0 h-2.5 w-2.5 rounded-full bg-warning" />
      ) : null}
    </View>
  );
}

function GoatBotHeaderTitle(props: { readonly state: GoatBotFaceState; readonly title: string }) {
  const label = goatBotFaceLabel(props.state);
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={label ? `${props.title}, ${label}` : props.title}
      className="flex-row items-center gap-2"
    >
      <GoatBotFaceAvatar state={props.state} size={28} />
      <Text className="text-base font-semibold text-foreground">{props.title}</Text>
    </View>
  );
}

/** Puts the main bot's face in the native header title (iOS; Android hides this header). */
export function GoatBotHeaderFace(props: {
  readonly activity: GoatBotFaceInput["activity"];
  readonly title: string;
}) {
  const state = useMobileGoatBotFace(props.activity);
  const title = props.title;
  const renderTitle = useCallback(
    () => <GoatBotHeaderTitle state={state} title={title} />,
    [state, title],
  );
  return <NativeStackScreenOptions options={{ headerTitle: renderTitle }} optionsVersion={state} />;
}

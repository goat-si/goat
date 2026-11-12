import {
  FACE_MOTION_RANK,
  GOAT_BOT_HEAD_EYES_ORIGIN,
  GOAT_BOT_HEAD_PATH,
  GOAT_BOT_HEAD_SLEEP_MARK_PATH,
  GOAT_BOT_HEAD_STROKE_WIDTH,
  GOAT_BOT_HEAD_VIEWBOX,
  goatBotAvatarEmoji,
  goatBotAvatarSignal,
  goatBotFaceLabel,
  goatBotHeadArt,
  type GoatBotAvatarSignal,
  type GoatBotAccent,
  type FaceMotion,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import { useCallback, useEffect, useState } from "react";
import {
  Animated as NativeAnimated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useAnimatedValue,
} from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useResolveClassNames, withUniwind } from "uniwind";

import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { goatBotSleepingAccent } from "./goatBotSleepingAccent";
import { useMobileGoatBotFace, useMobileGoatBotFaceMotion } from "./useMobileGoatBotFace";

const ThemedPath = withUniwind(Path);
const FACE_ENTERING = FadeIn.duration(150).reduceMotion(ReduceMotion.System);
const INK = "accent-icon";
/** The eyes are cut from the head in the screen's colour, as web's are in its background. */
const EYES = "accent-screen";
/** The head spans 20 grid units of its viewBox. */
const FACE_UNITS = 20;
const STILL_FRAMES = [
  { at: 0, x: 0, scaleY: 1 },
  { at: 1, x: 0, scaleY: 1 },
] as const;

/**
 * The bot's solid goat head with eyes that show what the bot is doing. The eyes are their own
 * view, so a moving face loops only that view's transform on React Native's native driver
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
  const art = goatBotHeadArt(props.state);
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
          viewBox={GOAT_BOT_HEAD_VIEWBOX}
        >
          <ThemedPath d={GOAT_BOT_HEAD_PATH} colorClassName={INK} fill="currentColor" />
          {art.sleepMark ? (
            <ThemedPath
              d={GOAT_BOT_HEAD_SLEEP_MARK_PATH}
              colorClassName={INK}
              fill="none"
              stroke="currentColor"
              strokeWidth={GOAT_BOT_HEAD_STROKE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </Svg>
        {/* A blink scales around the eye line. */}
        <NativeAnimated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { transformOrigin: GOAT_BOT_HEAD_EYES_ORIGIN, transform: [{ translateX }, { scaleY }] },
          ]}
        >
          <Svg width={props.size} height={props.size} viewBox={GOAT_BOT_HEAD_VIEWBOX}>
            {art.eyes === "" ? null : (
              <ThemedPath d={art.eyes} colorClassName={EYES} fill="currentColor" />
            )}
            {art.strokes === "" ? null : (
              <ThemedPath
                d={art.strokes}
                colorClassName={EYES}
                fill="none"
                stroke="currentColor"
                strokeWidth={GOAT_BOT_HEAD_STROKE_WIDTH}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </Svg>
        </NativeAnimated.View>
      </View>
    </Animated.View>
  );
}

/**
 * The waiting dot keeps clear of the head's ear in a small circle: web's share of the circle, 6 to
 * 10 px, and a pixel out on the corner below 32 px, where the ear nearly reaches the edge. Its ring,
 * in the colour behind the avatar, is drawn outside that fill so it parts the dot from any accent.
 */
function waitingDotStyle(circle: number) {
  const size = Math.min(10, Math.max(6, Math.round(circle * 0.28)));
  const out = circle < 32 ? -1 : 0;
  const ring = circle < 32 ? 1 : 1.5;
  return {
    width: size + ring * 2,
    height: size + ring * 2,
    borderWidth: ring,
    top: out - ring,
    right: out - ring,
  };
}

/** What the avatar sits on, so the waiting dot's ring matches it. */
type GoatBotAvatarSurface = "screen" | "selected" | "chip";

const DOT_RING: Record<GoatBotAvatarSurface, string> = {
  screen: "border-screen",
  selected: "border-thread-selected",
  chip: "border-goat-bot-message",
};

const SURFACE_FILL: Record<GoatBotAvatarSurface, string> = {
  screen: "bg-screen",
  selected: "bg-thread-selected",
  chip: "bg-goat-bot-message",
};

const RING: Record<NonNullable<GoatBotAvatarSignal["ring"]>, string> = {
  active: "border-primary",
  failed: "border-danger-foreground",
  finished: "border-adaptive-emerald-600-400",
};

/**
 * The bot's round avatar: its chosen emoji, else its face. The ring and dot carry the state
 * either way; callers put the face label in their own row label.
 */
export function GoatBotFaceAvatar(props: {
  readonly state: GoatBotFaceState;
  readonly size: number;
  readonly motion?: FaceMotion | null;
  /** The bot's profile avatar; an emoji replaces the drawn face. */
  readonly emoji?: string | null | undefined;
  /** A member's color fills its circle, with text that reads on it. */
  readonly accent?: GoatBotAccent | null | undefined;
  /** The surface behind the avatar; the screen when absent. */
  readonly surface?: GoatBotAvatarSurface;
}) {
  const picture = goatBotAvatarEmoji(props.emoji);
  const signal = goatBotAvatarSignal(props.state, picture !== null);
  const surface = useResolveClassNames("bg-grouped-card").backgroundColor;
  const awake = picture !== null ? (props.accent ?? null) : null;
  // Asleep, a coloured circle moves toward the surface instead of dimming its initial, whose colour
  // is chosen again for the mix; an uncoloured one dims as before.
  const accent =
    awake && signal.dimmed && typeof surface === "string"
      ? goatBotSleepingAccent(awake, surface)
      : awake;
  const place = props.surface ?? "screen";
  // A ring on a member's colour is parted from the fill by a hairline of the surface behind it, so
  // it reads on every colour; the circle keeps its size.
  const inset = accent !== null && signal.ring !== null;
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        ...(accent && !inset ? { backgroundColor: accent.background } : {}),
      }}
      className={`items-center justify-center rounded-full border ${inset ? SURFACE_FILL[place] : "bg-grouped-card"} ${signal.ring === null ? "border-transparent" : RING[signal.ring]}`}
    >
      {inset && accent ? (
        <View
          className="absolute rounded-full"
          style={{ top: 1, right: 1, bottom: 1, left: 1, backgroundColor: accent.background }}
        />
      ) : null}
      {picture !== null ? (
        <Text
          allowFontScaling={false}
          style={{
            fontSize: props.size * 0.5,
            lineHeight: props.size * 0.62,
            ...(accent ? { color: accent.foreground } : {}),
          }}
          // A member's initial needs a text colour; an emoji ignores it.
          className={signal.dimmed && !accent ? "text-foreground opacity-50" : "text-foreground"}
        >
          {picture}
        </Text>
      ) : (
        <GoatBotFace state={props.state} size={props.size * 0.86} motion={props.motion ?? null} />
      )}
      {signal.waitingDot ? (
        <View
          className={`absolute rounded-full bg-warning-foreground ${DOT_RING[place]}`}
          style={waitingDotStyle(props.size)}
        />
      ) : null}
    </View>
  );
}

/** The progress line's face takes the screen's one motion from the header while the line shows. */
const PROGRESS_FACE_RANK = FACE_MOTION_RANK.header + 1;

/**
 * The bot beside what it is doing: its drawn face, moving only while the line is in view and motion
 * is allowed, or its emoji or initial on its avatar circle, which never moves.
 */
export function GoatBotProgressFace(props: {
  readonly state: GoatBotFaceState;
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
  readonly inView: boolean;
}) {
  const emoji = goatBotAvatarEmoji(props.emoji);
  const accent = props.accent ?? null;
  const motion = useMobileGoatBotFaceMotion(
    props.state,
    PROGRESS_FACE_RANK,
    null,
    props.inView && emoji === null,
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-6 w-6 items-center justify-center"
    >
      {emoji !== null ? (
        <View
          className="h-5 w-5 items-center justify-center rounded-full bg-grouped-card"
          style={accent ? { backgroundColor: accent.background } : undefined}
        >
          <Text
            allowFontScaling={false}
            className="text-foreground"
            style={{
              fontSize: 11,
              lineHeight: 14,
              ...(accent ? { color: accent.foreground } : {}),
            }}
          >
            {emoji}
          </Text>
        </View>
      ) : (
        <GoatBotFace state={props.state} size={20} motion={motion} />
      )}
    </View>
  );
}

function GoatBotHeaderTitle(props: {
  readonly state: GoatBotFaceState;
  readonly motion: FaceMotion | null;
  readonly title: string;
  readonly emoji: string | null;
  readonly accent: GoatBotAccent | null;
  readonly onPress?: (() => void) | undefined;
}) {
  const label = goatBotFaceLabel(props.state);
  const accessibilityLabel = label ? `${props.title}, ${label}` : props.title;
  if (props.onPress) {
    // The chat's header is one chip: the bot's face and name, which opens its home.
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={`Opens ${props.title}'s home`}
        onPress={props.onPress}
        className="min-h-[44px] justify-center"
      >
        <View
          collapsable={false}
          className="flex-row items-center gap-2 rounded-full bg-goat-bot-message py-1 pl-1 pr-3"
        >
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <GoatBotFaceAvatar
              state={props.state}
              size={28}
              motion={props.motion}
              emoji={props.emoji}
              accent={props.accent}
              surface="chip"
            />
          </View>
          <Text key={accessibilityLabel} className="text-base font-semibold text-foreground">
            {props.title}
          </Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </View>
      </Pressable>
    );
  }
  return (
    // Unflattened so the text swap below stays in this row and leaves the native title view alone.
    <View collapsable={false} className="flex-row items-center gap-2">
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <GoatBotFaceAvatar
          state={props.state}
          size={28}
          motion={props.motion}
          emoji={props.emoji}
          accent={props.accent}
        />
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

/** The bot's face as it is now, for the chat's header chip on Android, which draws its own. */
export function GoatBotChipFace(props: {
  readonly activity: GoatBotFaceInput["activity"];
  /** A member bot's conversation; the main bot's when absent. */
  readonly conversation?: Parameters<typeof useMobileGoatBotFace>[1];
  /** The bot's profile avatar, or a member's initial. */
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const face = useMobileGoatBotFace(props.activity, props.conversation);
  return (
    <GoatBotFaceAvatar
      state={face.state}
      size={24}
      emoji={props.emoji}
      accent={props.accent}
      surface="chip"
    />
  );
}

/** Puts the main bot's face in the native header title (iOS; Android hides this header). */
export function GoatBotHeaderFace(props: {
  readonly activity: GoatBotFaceInput["activity"];
  readonly title: string;
  /** A member bot's conversation; the main bot's when absent. */
  readonly conversation?: Parameters<typeof useMobileGoatBotFace>[1];
  /** The bot's profile avatar. */
  readonly emoji?: string | null | undefined;
  readonly accent?: GoatBotAccent | null | undefined;
  /** Opens the bot's home; absent on a task's own screen, whose header is that task. */
  readonly onPress?: (() => void) | undefined;
}) {
  const face = useMobileGoatBotFace(props.activity, props.conversation);
  const emoji = goatBotAvatarEmoji(props.emoji);
  // The header shows whenever its screen is focused, which the motion hook already checks; an
  // emoji has no eyes, so it never takes the one moving face.
  const motion = useMobileGoatBotFaceMotion(
    face.state,
    FACE_MOTION_RANK.header,
    face.since,
    emoji === null,
  );
  const { state } = face;
  const title = props.title;
  const onPress = props.onPress;
  const accent = props.accent ?? null;
  const renderTitle = useCallback(
    () => (
      <GoatBotHeaderTitle
        state={state}
        motion={motion}
        title={title}
        emoji={emoji}
        accent={accent}
        onPress={onPress}
      />
    ),
    [state, motion, title, emoji, accent, onPress],
  );
  return (
    <NativeStackScreenOptions
      // The title is also the navigation bar's accessible name; the stack's default says GOAT Bot.
      options={{ title, headerTitle: renderTitle }}
      optionsVersion={`${title}:${state}:${emoji ?? ""}:${accent?.background ?? ""}:${motion === null ? "still" : "moving"}:${onPress ? "chip" : "title"}`}
    />
  );
}

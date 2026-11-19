import { Platform } from "react-native";
import { FadeIn, ReduceMotion } from "react-native-reanimated";
import { COMPOSER_TRANSITION_DURATION_MS } from "./composerTransitions";

export const COMPOSER_COLLAPSED_CHROME = 60;
// Share of the one-row composer the draft keeps; a long model name truncates first.
export const INLINE_EDITOR_MIN_WIDTH = "40%";

export const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

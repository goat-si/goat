import { MOTION } from "@goat/shared/motionTokens";

export const MOBILE_SHAPE = {
  /** Same as --radius-card in global.css. */
  card: 16,
  group: { ios: 24, android: 28 },
  toast: 26,
  glass: 32,
} as const;

export const MOBILE_MOTION = MOTION;

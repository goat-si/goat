import { Platform } from "react-native";

/** The platform's system face. The family no longer encodes weight; set fontWeight beside it. */
const SYSTEM_FONT_FAMILY = Platform.OS === "android" ? "sans-serif" : "System";

export const FONT_FAMILIES = {
  regular: SYSTEM_FONT_FAMILY,
  // Link chips take a family but no weight. Android names its medium face; iOS has no public name.
  medium: Platform.OS === "android" ? "sans-serif-medium" : SYSTEM_FONT_FAMILY,
  bold: SYSTEM_FONT_FAMILY,
} as const;

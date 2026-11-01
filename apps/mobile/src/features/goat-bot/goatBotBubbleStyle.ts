import type { GoatBotGroupPosition } from "@goat/client-runtime/goatBot";

export type BubbleSide = "out" | "in";

export const GOAT_BOT_BUBBLE_COLORS = {
  light: { out: "#1466D0", outText: "#FFFFFF", in: "#E9E9EB", inText: "#000000" },
  dark: { out: "#2B66C6", outText: "#FFFFFF", in: "#3A3A3C", inText: "#FFFFFF" },
} as const;

export function goatBotBubbleLayout(position: GoatBotGroupPosition): {
  readonly marginTop: number;
  readonly tail: boolean;
} {
  return {
    marginTop: position === "single" || position === "first" ? 12 : 4,
    tail: position === "single" || position === "last",
  };
}

import type { BotProfile } from "@goat/contracts";

/**
 * GOAT's accents for member bots. Each takes white text at 5:1 or better, as chat bubbles do;
 * Amber, light by nature, takes black.
 */
export const GOAT_BOT_COLORS = [
  { name: "Blue", value: "#2563EB" },
  { name: "Teal", value: "#0F766E" },
  { name: "Green", value: "#15803D" },
  { name: "Amber", value: "#D9A21B" },
  { name: "Orange", value: "#C2410C" },
  { name: "Rose", value: "#BE185D" },
  { name: "Violet", value: "#6D28D9" },
] as const;

/** A bot's accent and the text color that stays readable on it. */
export interface GoatBotAccent {
  readonly background: string;
  readonly foreground: "#000000" | "#FFFFFF";
}

const HEX = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/;

const channel = (hex: string) => {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#RRGGBB` color. */
const luminance = (red: string, green: string, blue: string) =>
  0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);

/** WCAG contrast ratio between two luminances. */
export const contrastRatio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * A member's accent with black or white text, whichever contrasts more. The main bot, a member
 * without a color, and a value that is not `#RRGGBB` get none: they stay the theme's neutral.
 */
export function goatBotAccent(
  bot: Pick<BotProfile, "role" | "color"> | null | undefined,
): GoatBotAccent | null {
  if (bot == null || bot.role !== "member" || bot.color === undefined) return null;
  const parts = HEX.exec(bot.color);
  if (parts === null) return null;
  const level = luminance(parts[1] ?? "00", parts[2] ?? "00", parts[3] ?? "00");
  return {
    background: bot.color.toUpperCase(),
    foreground: contrastRatio(level, 0) >= contrastRatio(level, 1) ? "#000000" : "#FFFFFF",
  };
}

/** Whether two stored colors are the same; case does not matter. */
export const sameBotColor = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null)?.toUpperCase() === (b ?? null)?.toUpperCase();

import { type GoatBotAccent, goatBotAccent } from "@goat/client-runtime/goatBot";

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/iu;
const RGB = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/iu;

function channels(color: string): readonly [number, number, number] | null {
  const hex = HEX.exec(color);
  const rgb = RGB.exec(color);
  const parts = hex
    ? [hex[1], hex[2], hex[3]].map((part) => Number.parseInt(part ?? "0", 16))
    : rgb
      ? [rgb[1], rgb[2], rgb[3]].map((part) => Number(part ?? 0))
      : null;
  if (parts === null) return null;
  const [red = 0, green = 0, blue = 0] = parts;
  return [red, green, blue];
}

/**
 * A sleeping member's circle: its colour mixed halfway toward the surface it sits on, opaque, with
 * the initial's colour chosen again for that mix, so asleep reads quieter without losing contrast.
 * A surface that is not a plain colour keeps the awake colours.
 */
export function goatBotSleepingAccent(accent: GoatBotAccent, surface: string): GoatBotAccent {
  const from = channels(accent.background);
  const toward = channels(surface);
  if (from === null || toward === null) return accent;
  const mixed = `#${from
    .map((value, index) => Math.round((value + (toward[index] ?? value)) / 2))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
  return goatBotAccent({ role: "member", color: mixed }) ?? accent;
}

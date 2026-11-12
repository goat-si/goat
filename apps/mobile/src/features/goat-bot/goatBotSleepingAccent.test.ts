import * as NodeFS from "node:fs";

import { GOAT_BOT_COLORS, contrastRatio, goatBotAccent } from "@goat/client-runtime/goatBot";
import { expect, it } from "vite-plus/test";

import { goatBotSleepingAccent } from "./goatBotSleepingAccent";

const channel = (value: number) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return 0.2126 * channel(red ?? 0) + 0.7152 * channel(green ?? 0) + 0.0722 * channel(blue ?? 0);
};

// Every theme's card surface, light and dark, as the app ships them.
const surfaces = [
  ...NodeFS.readFileSync(
    new URL("../../../generated-uniwind-themes.css", import.meta.url),
    "utf8",
  ).matchAll(/--color-grouped-card: (#[0-9a-fA-F]{6});/g),
].map((match) => match[1] ?? "");

it("keeps a sleeping member's initial at 4.5:1 or better on every palette colour and theme surface", () => {
  expect(surfaces.length).toBeGreaterThan(1);
  for (const { name, value } of GOAT_BOT_COLORS) {
    const awake = goatBotAccent({ role: "member", color: value });
    if (awake === null) throw new Error(`${name} has no accent`);
    for (const surface of surfaces) {
      const sleeping = goatBotSleepingAccent(awake, surface);
      const ratio = contrastRatio(luminance(sleeping.background), luminance(sleeping.foreground));
      expect(ratio, `${name} on ${surface}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      // Asleep still reads as quieter than awake: the circle moves toward the surface.
      expect(sleeping.background).not.toBe(awake.background);
    }
  }
});

it("keeps the awake colour when the surface is not a plain colour it can mix with", () => {
  const awake = goatBotAccent({ role: "member", color: "#2563EB" });
  if (awake === null) throw new Error("Blue has no accent");
  expect(goatBotSleepingAccent(awake, "transparent")).toEqual(awake);
});

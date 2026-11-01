import { describe, expect, it } from "vite-plus/test";
import { LEGACY_THEME_ID_ALIASES } from "@goat/contracts/legacyT3Names";
import {
  normalizeThemeId,
  normalizeThemePreference,
  RESERVED_THEME_IDS,
  deriveSemanticColors,
  deriveSemanticColorsFrom,
  mixOklab,
  GOAT_LIGHT_THEME_COLORS,
  GOAT_DARK_THEME_COLORS,
} from "./themePalettes.ts";

function channels(hex: string) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function expectHexClose(actual: string, expected: string) {
  expect(actual).toMatch(/^#[\da-f]{6}$/);
  channels(actual).forEach((channel, index) => {
    expect(Math.abs(channel - channels(expected)[index]!)).toBeLessThanOrEqual(1);
  });
}

describe("semantic colors", () => {
  // OKLab reference mixes, encoded to 8-bit sRGB. Neutrals have L = cbrt(linear RGB).
  it.each([
    ["#ffffff", "#000000", 0.5, "#636363"],
    ["#f00", "#0000ff", 0.5, "#8c53a2"],
    ["oklch(62.7955361% 0.2576833 29.2338852)", "#0000ff", 0.5, "#8c53a2"],
    ["rgb(255, 0, 0)", "rgb(0 0 255)", 0.5, "#8c53a2"],
    ["rgb(100% 100% 100%)", "#000000ff", 0.86, "#d1d1d1"],
    ["oklch(100% 0 0)", "oklch(0 0 0)", 0.55, "#717171"],
    ["oklch(1 0 0)", "#000", 0.12, "#060606"],
    ["#123456", "#abcdef", 1, "#123456"],
    ["#123456", "#abcdef", 0, "#abcdef"],
  ] as const)("mixes %s with %s at %s", (first, second, weight, expected) => {
    expectHexClose(mixOklab(first, second, weight), expected);
  });

  it("derives from text, canvas, mutedForeground, messageAction and solid error roles", () => {
    const semantic = deriveSemanticColors(
      {
        ...GOAT_LIGHT_THEME_COLORS,
        text: "#ffffff",
        canvas: "#000000",
        mutedForeground: "#000000",
        messageAction: "#ffffff",
        error: "#ffffff",
        errorForeground: "#ffffff",
      },
      "light",
    );
    expectHexClose(semantic.prClosed, "#717171");
    expectHexClose(semantic.composerSend, "#d1d1d1");
    expectHexClose(semantic.composerStop, "#d1d1d1");
    expectHexClose(semantic.goatAvatar, "#010101");
    expectHexClose(semantic.goatAvatarBorder, "#060606");
    expectHexClose(semantic.goatAvatarForeground, "#c4c4c4");
  });

  it("omits composerStop when effective colors offer no solid error", () => {
    const semantic = deriveSemanticColorsFrom({
      text: "#ffffff",
      canvas: "#000000",
      mutedForeground: "#000000",
      messageAction: "#ffffff",
      errorForeground: "#ffffff",
      appearance: "dark",
    });
    expect(semantic).not.toHaveProperty("composerStop");
    expectHexClose(semantic.composerSend, "#d1d1d1");
  });

  it.each(["light", "dark"] as const)(
    "retains PR hues and deepens GOAT %s actions",
    (appearance) => {
      const colors = appearance === "light" ? GOAT_LIGHT_THEME_COLORS : GOAT_DARK_THEME_COLORS;
      const semantic = deriveSemanticColors(colors, appearance);
      const muted = channels(colors.mutedForeground);
      const open = channels(semantic.prOpen);
      const closed = channels(semantic.prClosed);
      const merged = channels(semantic.prMerged);
      expect(open[1]! - open[0]!).toBeGreaterThan(muted[1]! - muted[0]!);
      expect(closed[0]! - closed[1]!).toBeGreaterThan(muted[0]! - muted[1]!);
      expect(merged[0]! - merged[1]!).toBeGreaterThan(muted[0]! - muted[1]!);
      expect(merged[2]! - merged[1]!).toBeGreaterThan(muted[2]! - muted[1]!);
      for (const [derived, source] of [
        [semantic.composerSend, colors.messageAction],
        [semantic.composerStop, colors.error],
      ]) {
        channels(derived!).forEach((channel, index) =>
          expect(channel).toBeLessThan(channels(source!)[index]!),
        );
      }
    },
  );
});

describe("persisted theme ids", () => {
  it.each(Object.entries(LEGACY_THEME_ID_ALIASES))("reads %s as %s", (legacy, current) => {
    expect(normalizeThemePreference(legacy)).toBe(current);
    expect(RESERVED_THEME_IDS.has(legacy)).toBe(true);
  });

  // goat-rename: legacy-begin
  it.each([
    ["t3-chat", "goat-chat"],
    ["t3-chat-light", "goat-chat"],
    ["t3-chat-dark", "goat-chat"],
    ["t3-code", "goat-code"],
    ["t3-code-light", "goat-code"],
    ["t3-code-dark", "goat-code"],
  ])("loads %s as palette %s", (legacy, palette) => {
    expect(normalizeThemeId(legacy)).toBe(palette);
  });
  // goat-rename: legacy-end

  it("leaves custom ids and appearance keywords unchanged", () => {
    for (const id of ["custom-dark", "light", "dark", "system", "toString", "constructor"]) {
      expect(normalizeThemePreference(id)).toBe(id);
      expect(normalizeThemeId(id)).toBe(id);
    }
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  readableDarkSyntaxColor,
  readableOnDarkCode,
  readableOnLightCode,
  readableSyntaxColor,
} from "./readableSyntaxTheme";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return (Math.atan2(Math.sqrt(3) * (g! - b!), 2 * r! - g! - b!) * 180) / Math.PI;
}

// pierre-light's faintest syntax colors: yellow, cyan, orange, teal, green, pink.
const PIERRE_LIGHT_FAINT = ["#d5a910", "#08c0ef", "#d5901c", "#1ca1c7", "#199f43", "#d32a61"];
// Light code surfaces: the code background, added and deleted lines, and changed words on each.
const LIGHT_CODE_SURFACES = ["#fcfcfc", "#ecf9f4", "#fef0f0", "#ccecdf", "#f8d3d4"];

describe("readableOnLightCode", () => {
  it("brings pierre-light's faint colors to 4.5:1 on every light code surface", () => {
    for (const color of PIERRE_LIGHT_FAINT) {
      for (const surface of LIGHT_CODE_SURFACES) {
        expect(contrast(readableOnLightCode(color), surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps tokens that differed only in lightness apart, in pierre-light's order", () => {
    // [lighter, darker] in pierre-light: comment/punctuation, operator/number, property/decorator.
    for (const [lighter, darker] of [
      ["#737373", "#636363"],
      ["#08c0ef", "#1ca1c7"],
      ["#009fff", "#1a85d4"],
    ] as const) {
      expect(luminance(readableSyntaxColor(lighter))).toBeGreaterThan(
        luminance(readableSyntaxColor(darker)) + 0.02,
      );
    }
  });

  it("leaves colors that already read unchanged", () => {
    expect(readableOnLightCode("#693acf")).toBe("#693acf");
    expect(readableOnLightCode("#0a0a0a")).toBe("#0a0a0a");
  });

  it("keeps an alpha suffix and ignores non-hex values", () => {
    expect(readableOnLightCode("#d5a91080")).toMatch(/80$/);
    expect(readableOnLightCode("var(--x)")).toBe("var(--x)");
  });
});

// pierre-dark's colors under 4.5:1 on its lightest code surface: punctuation, comment, diff
// minus red, function purple, type magenta, property blue, keyword pink.
const PIERRE_DARK_FAINT = [
  "#636363",
  "#737373",
  "#ff2e3f",
  "#9d6afb",
  "#d568ea",
  "#009fff",
  "#ff678d",
];
// Dark code surfaces: the code background, then added and deleted lines and the changed words on
// each, in the default and the blue-orange diff colors.
const DARK_CODE_SURFACES = [
  "#101010",
  "#111a17",
  "#1f1414",
  "#0e3b2c",
  "#4b191d",
  "#15181e",
  "#1f1810",
  "#1a324b",
  "#4c2f0e",
];

describe("readableOnDarkCode", () => {
  it("brings pierre-dark's faint colors to 4.5:1 on every dark code surface", () => {
    for (const color of PIERRE_DARK_FAINT) {
      for (const surface of DARK_CODE_SURFACES) {
        expect(contrast(readableDarkSyntaxColor(color), surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps each faint color's hue", () => {
    for (const color of PIERRE_DARK_FAINT.filter((color) => !/^#(..)\1\1$/.test(color))) {
      expect(Math.abs(hue(readableOnDarkCode(color)) - hue(color))).toBeLessThan(2);
    }
  });

  it("keeps comments the quietest gray, below punctuation and then parameters", () => {
    const [comment, punctuation, parameter] = ["#737373", "#636363", "#a3a3a3"].map((color) =>
      luminance(readableDarkSyntaxColor(color)),
    );
    expect(punctuation!).toBeGreaterThan(comment! + 0.02);
    expect(parameter!).toBeGreaterThan(punctuation! + 0.02);
  });

  it("leaves colors that already read unchanged", () => {
    expect(readableOnDarkCode("#ffd452")).toBe("#ffd452");
    expect(readableOnDarkCode("#5ecc71")).toBe("#5ecc71");
    expect(readableOnDarkCode("#73737380")).toMatch(/80$/);
  });
});

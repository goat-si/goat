import { getResolvedOrResolveTheme, registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

/** pierre-light with every syntax color darkened until it reads on every light code surface. */
export const READABLE_LIGHT_THEME_NAME = "goat-light";
/** pierre-dark with every syntax color lightened until it reads on every dark code surface. */
export const READABLE_DARK_THEME_NAME = "goat-dark";

const MIN_CONTRAST = 4.5;
// The darkest light code surface is a changed word on a deleted line (#f8d3d4, luminance
// 0.71), rounded down for margin.
const DARKEST_SURFACE_LUMINANCE = 0.69;
// The lightest dark code surface is a changed word on a deleted line in the blue-orange diff
// colors (#4c2f0e, luminance 0.036), rounded up for margin.
const LIGHTEST_DARK_SURFACE_LUMINANCE = 0.037;

type Rgb = [number, number, number];

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(channelLuminance) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const LIGHT_CODE = {
  contrast: (rgb: Rgb) => (DARKEST_SURFACE_LUMINANCE + 0.05) / (luminance(rgb) + 0.05),
  // Scaling toward black keeps the hue.
  step: (channel: number) => Math.floor(channel * 0.96),
};

const DARK_CODE = {
  contrast: (rgb: Rgb) => (luminance(rgb) + 0.05) / (LIGHTEST_DARK_SURFACE_LUMINANCE + 0.05),
  // Mixing toward white keeps the hue.
  step: (channel: number) => 255 - Math.floor((255 - channel) * 0.96),
};

function readableOnCode(
  color: string,
  minContrast: number,
  code: typeof LIGHT_CODE | typeof DARK_CODE,
): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return color;
  let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as Rgb;
  if (code.contrast(rgb) >= minContrast) return color;
  while (code.contrast(rgb) < minContrast) {
    rgb = rgb.map(code.step) as Rgb;
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
}

/** Darkens a #rrggbb(aa) color in steps that keep its hue until it reads on light code. */
export function readableOnLightCode(color: string, minContrast = MIN_CONTRAST): string {
  return readableOnCode(color, minContrast, LIGHT_CODE);
}

/** Lightens a #rrggbb(aa) color in steps that keep its hue until it reads on dark code. */
export function readableOnDarkCode(color: string, minContrast = MIN_CONTRAST): string {
  return readableOnCode(color, minContrast, DARK_CODE);
}

type ZedTheme = NonNullable<DiffsTheme["zed"]>;

// Pairs that differ only in lightness would merge at one floor. The darker color of each pair
// goes further, keeping pierre-light's order: numbers stay darker than operators, punctuation
// darker than comments, and decorators darker than property names.
const FURTHER_COLORS = new Set(["#1ca1c7", "#636363", "#1a85d4"]);
const FURTHER_MIN_CONTRAST = 6;

/** The goat-light color for a pierre-light syntax color. */
export function readableSyntaxColor(color: string): string {
  return readableOnLightCode(
    color,
    FURTHER_COLORS.has(color.toLowerCase()) ? FURTHER_MIN_CONTRAST : MIN_CONTRAST,
  );
}

// pierre-dark's grays would merge at one floor. Comments take the floor and stay the quietest
// text, as in goat-light; punctuation and then parameters go further.
const DARK_FURTHER_MIN_CONTRAST = new Map([
  ["#636363", 5],
  ["#a3a3a3", 5.5],
]);

/** The goat-dark color for a pierre-dark syntax color. */
export function readableDarkSyntaxColor(color: string): string {
  return readableOnDarkCode(
    color,
    DARK_FURTHER_MIN_CONTRAST.get(color.toLowerCase()) ?? MIN_CONTRAST,
  );
}

function withReadableSyntax(
  theme: ZedTheme,
  name: string,
  readable: (color: string) => string,
): ZedTheme {
  const syntax = Object.fromEntries(
    Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => [
      scope,
      typeof style === "string"
        ? readable(style)
        : style.color
          ? { ...style, color: readable(style.color) }
          : style,
    ]),
  );
  return { ...theme, name, style: { ...theme.style, syntax } };
}

// Themes resolve on the main thread and reach the diff workers already resolved.
for (const [name, baseName, readable] of [
  [READABLE_LIGHT_THEME_NAME, "pierre-light", readableSyntaxColor],
  [READABLE_DARK_THEME_NAME, "pierre-dark", readableDarkSyntaxColor],
] as const) {
  registerCustomTheme(
    name,
    async () => {
      const base = await getResolvedOrResolveTheme(baseName, "highlights");
      if (!base.zed) throw new Error(`${baseName} has no Highlights palette`);
      return withReadableSyntax(base.zed, name, readable);
    },
    "zed",
  );
}

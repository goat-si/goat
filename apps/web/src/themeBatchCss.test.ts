import { expect, it } from "vite-plus/test";
import { parseThemeFile, THEME_FILE_VERSION } from "./themePalette";
import { pairVsCodeThemes, resolveThemeLabelCollisions } from "./vscodeThemeImport";

const theme = (name: string, appearance: "light" | "dark", css: string) =>
  parseThemeFile({
    version: THEME_FILE_VERSION,
    name,
    appearance,
    colors: { canvas: "#112233" },
    css,
  });

it("keeps a stylesheet when pairing matching light and dark themes", () => {
  const css = '[data-slot="sidebar"]{color:red}';
  const themes = pairVsCodeThemes([
    theme("Daylight Light", "light", css),
    theme("Daylight Dark", "dark", css),
  ]);
  expect(themes).toHaveLength(1);
  expect(themes[0]?.css).toBe(css);
});

it("keeps conflicting stylesheets separate when pairing themes", () => {
  const themes = pairVsCodeThemes([
    theme("Daylight Light", "light", '[data-slot="sidebar"]{color:red}'),
    theme("Daylight Dark", "dark", '[data-slot="sidebar"]{color:blue}'),
  ]);
  expect(themes).toHaveLength(2);
  expect(themes.map((item) => item.css)).toEqual([
    '[data-slot="sidebar"]{color:red}',
    '[data-slot="sidebar"]{color:blue}',
  ]);
});

it("keeps CSS on each theme renamed during batch collision resolution", () => {
  const css = '[data-slot="sidebar"]{color:red}';
  const original = theme("Shared", "dark", css);
  const renamed = resolveThemeLabelCollisions([
    { theme: original, sourceName: "first.json" },
    { theme: original, sourceName: "second.json" },
  ]);
  expect(new Set(renamed.map((item) => item.id)).size).toBe(2);
  expect(renamed.map((item) => item.css)).toEqual([css, css]);
});

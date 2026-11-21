import { expect, it } from "vite-plus/test";
import { getDefaultThemeColors, type ThemeDefinition } from "./themePalette";
import { publishedBackgroundForSelection } from "./themeBackgroundSelection";

it("never uses a published background for a saved theme with the same ID", () => {
  const published: ThemeDefinition = {
    id: "nightfall",
    label: "Published",
    appearance: "dark",
    colors: getDefaultThemeColors("dark"),
  };
  const saved: ThemeDefinition = { ...published, label: "Saved" };
  const themes = [
    {
      id: "nightfall",
      name: "Published",
      appearance: "dark" as const,
      background: `png:${"a".repeat(64)}`,
    },
  ];
  expect(publishedBackgroundForSelection(saved, [published], themes)).toBeNull();
  expect(publishedBackgroundForSelection(published, [published], themes)).toEqual({
    themeId: "nightfall",
    revision: themes[0]!.background,
  });
});

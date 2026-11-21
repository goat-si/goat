import type { EnvironmentTheme } from "@goat/contracts";
import type { ThemeDefinition } from "./themePalette";
export function publishedBackgroundForSelection(
  selected: ThemeDefinition | null,
  published: ReadonlyArray<ThemeDefinition>,
  themes: ReadonlyArray<EnvironmentTheme>,
): { themeId: string; revision: string } | null {
  if (selected === null || !published.includes(selected)) return null;
  const revision = themes.find((theme) => theme.id === selected.id)?.background;
  return revision === undefined ? null : { themeId: selected.id, revision };
}

import { parseThemeFile, THEME_FILE_VERSION, type ThemeDefinition } from "./themePalette";

export function renameTheme(theme: ThemeDefinition, name: string): ThemeDefinition {
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    name,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.managed ? { managed: true } : {}),
    ...(theme.css !== undefined ? { css: theme.css } : {}),
  });
}

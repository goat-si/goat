import type { ThemeDefinition } from "@goat/shared/themePalettes";

export const ENVIRONMENT_THEMES_STORAGE_KEY = "goat:environment-themes:v1";

export function readEnvironmentThemeCache(
  parseThemes: (themes: ReadonlyArray<unknown>) => ReadonlyArray<ThemeDefinition>,
): ReadonlyArray<ThemeDefinition> {
  try {
    const raw =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(ENVIRONMENT_THEMES_STORAGE_KEY);
    const parsed: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(parsed) ? parseThemes(parsed) : [];
  } catch {
    return [];
  }
}

export function writeEnvironmentThemeCache(themes: ReadonlyArray<ThemeDefinition>): void {
  try {
    window.localStorage.setItem(ENVIRONMENT_THEMES_STORAGE_KEY, JSON.stringify(themes));
  } catch {
    // Storage may be unavailable; the live themes remain usable.
  }
}

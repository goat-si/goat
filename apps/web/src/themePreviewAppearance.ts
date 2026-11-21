import type { ThemeAppearance } from "@goat/shared/themePalettes";

const themePreviewListeners = new Set<() => void>();
let themePreviewAppearance: ThemeAppearance | null = null;

export function getThemePreviewAppearance(): ThemeAppearance | null {
  return themePreviewAppearance;
}

export function subscribeToThemePreview(listener: () => void): () => void {
  themePreviewListeners.add(listener);
  return () => themePreviewListeners.delete(listener);
}

export function setThemePreviewAppearance(appearance: ThemeAppearance | null): void {
  if (themePreviewAppearance === appearance) return;
  themePreviewAppearance = appearance;
  for (const listener of themePreviewListeners) listener();
}

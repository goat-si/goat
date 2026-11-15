import type { DesktopPreviewAnnotationTheme } from "@goat/contracts";

export const applyAnnotationTheme = (
  host: HTMLElement,
  theme: DesktopPreviewAnnotationTheme | null,
): void => {
  if (!theme) return;
  host.style.colorScheme = theme.colorScheme;
  const variables = {
    "--goat-radius": theme.radius,
    "--goat-background": theme.background,
    "--goat-foreground": theme.foreground,
    "--goat-popover": theme.popover,
    "--goat-popover-foreground": theme.popoverForeground,
    "--goat-primary": theme.primary,
    "--goat-primary-foreground": theme.primaryForeground,
    "--goat-muted": theme.muted,
    "--goat-muted-foreground": theme.mutedForeground,
    "--goat-accent": theme.accent,
    "--goat-accent-foreground": theme.accentForeground,
    "--goat-border": theme.border,
    "--goat-input": theme.input,
    "--goat-ring": theme.ring,
    "--goat-font-sans": theme.fontSans,
    "--goat-font-mono": theme.fontMono,
  };
  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value);
  }
};

export const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

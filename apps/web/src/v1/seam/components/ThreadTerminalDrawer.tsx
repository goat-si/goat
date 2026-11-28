// Seam for v1 apps/web/src/components/ThreadTerminalDrawer.tsx (goat 916b5ccc1b2): only terminalThemeFromApp, used by
// the terminal sign-in surface, which GOAT 2 does not have (seam terminal/ghostty/surface.ts).
import type { GhosttyTheme } from "../terminal/ghostty/surface";

export function terminalThemeFromApp(_mountElement?: HTMLElement | null): GhosttyTheme {
  return {};
}

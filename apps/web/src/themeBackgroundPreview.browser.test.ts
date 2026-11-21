import { expect, it } from "vite-plus/test";
import { applyThemeColorPreview, getDefaultThemeColors } from "./themePalette";
import {
  getRenderedAppearance,
  getThemeSnapshot,
  setAppearanceMode,
  setTheme,
} from "./hooks/useTheme";

it("keeps the intended theme identity while an editor previews another appearance", () => {
  const previous = getThemeSnapshot();
  try {
    expect(setTheme("grove")).toBe(true);
    expect(setAppearanceMode("light")).toBe(true);
    const intended = getThemeSnapshot();
    applyThemeColorPreview(getDefaultThemeColors("dark"), "dark");
    expect(getRenderedAppearance()).toBe("dark");
    expect(getThemeSnapshot().theme).toBe(intended.theme);
    expect(getThemeSnapshot().resolvedTheme).toBe("light");
  } finally {
    setTheme(previous.theme);
    setAppearanceMode(previous.appearanceMode);
  }
});

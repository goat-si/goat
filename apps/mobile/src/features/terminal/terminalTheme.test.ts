import { describe, expect, it } from "vite-plus/test";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("uses the shared default dark terminal colors", () => {
    expect(getMobileTerminalTheme("goat-code", "dark")).toMatchObject({
      background: "#171717",
      foreground: "#f5f5f5",
      cursorForeground: "#b4cbff",
      cursorBackground: "#171717",
    });
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getMobileTerminalTheme("goat-code", "dark"));

    expect(config).toContain("background = #171717");
    expect(config).toContain("foreground = #f5f5f5");
    expect(config).toContain("cursor-color = #b4cbff");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});

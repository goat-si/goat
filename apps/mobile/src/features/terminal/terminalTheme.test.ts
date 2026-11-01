import { describe, expect, it } from "vite-plus/test";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("uses the shared default dark terminal colors", () => {
    expect(getMobileTerminalTheme("goat-code", "dark")).toMatchObject({
      background: "#181818",
      foreground: "#ececec",
      cursorForeground: "#b4cbff",
      cursorBackground: "#181818",
    });
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getMobileTerminalTheme("goat-code", "dark"));

    expect(config).toContain("background = #181818");
    expect(config).toContain("foreground = #ececec");
    expect(config).toContain("cursor-color = #b4cbff");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});

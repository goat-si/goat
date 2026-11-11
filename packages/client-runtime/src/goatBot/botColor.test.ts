import { describe, expect, it } from "vite-plus/test";

import { contrastRatio, GOAT_BOT_COLORS, goatBotAccent } from "./botColor.ts";

const member = (color?: string) => ({ role: "member" as const, ...(color ? { color } : {}) });
const level = (hex: string) => {
  const lin = (part: string) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin(hex.slice(1, 3)) + 0.7152 * lin(hex.slice(3, 5)) + 0.0722 * lin(hex.slice(5, 7))
  );
};

describe("goatBotAccent", () => {
  it("keeps text on every GOAT color at 4.5:1 or better", () => {
    for (const { value } of GOAT_BOT_COLORS) {
      const accent = goatBotAccent(member(value));
      expect(accent, value).not.toBeNull();
      expect(contrastRatio(level(value), level(accent!.foreground)), value).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("puts white text on every GOAT color but Amber", () => {
    expect(
      GOAT_BOT_COLORS.filter(
        ({ value }) => goatBotAccent(member(value))?.foreground === "#000000",
      ).map(({ name }) => name),
    ).toEqual(["Amber"]);
  });

  it("picks black text on light colors and white on dark ones", () => {
    expect(goatBotAccent(member("#ffffff"))).toEqual({
      background: "#FFFFFF",
      foreground: "#000000",
    });
    expect(goatBotAccent(member("#000000"))?.foreground).toBe("#FFFFFF");
  });

  it("leaves the main bot, a member without a color and anything but #RRGGBB neutral", () => {
    expect(goatBotAccent({ role: "main", color: "#2F6FED" })).toBeNull();
    expect(goatBotAccent(member())).toBeNull();
    expect(goatBotAccent(null)).toBeNull();
    for (const color of ["red", "#fff", "url(x)", "#2F6FED; background: red"]) {
      expect(goatBotAccent(member(color)), color).toBeNull();
    }
  });
});

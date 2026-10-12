import { describe, expect, it } from "vite-plus/test";
import { LEGACY_THEME_ID_ALIASES } from "@goat/contracts/legacyT3Names";
import { normalizeThemeId, normalizeThemePreference, RESERVED_THEME_IDS } from "./themePalettes.ts";

describe("persisted theme ids", () => {
  it.each(Object.entries(LEGACY_THEME_ID_ALIASES))("reads %s as %s", (legacy, current) => {
    expect(normalizeThemePreference(legacy)).toBe(current);
    expect(RESERVED_THEME_IDS.has(legacy)).toBe(true);
  });

  // goat-rename: legacy-begin
  it.each([
    ["t3-chat", "goat-chat"],
    ["t3-chat-light", "goat-chat"],
    ["t3-chat-dark", "goat-chat"],
    ["t3-code", "goat-code"],
    ["t3-code-light", "goat-code"],
    ["t3-code-dark", "goat-code"],
  ])("loads %s as palette %s", (legacy, palette) => {
    expect(normalizeThemeId(legacy)).toBe(palette);
  });
  // goat-rename: legacy-end

  it("leaves custom ids and appearance keywords unchanged", () => {
    for (const id of ["custom-dark", "light", "dark", "system", "toString", "constructor"]) {
      expect(normalizeThemePreference(id)).toBe(id);
      expect(normalizeThemeId(id)).toBe(id);
    }
  });
});

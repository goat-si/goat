import { describe, expect, it } from "vite-plus/test";

import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import type { MaterialYouPalette } from "./materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "./materialYouTheme.android";

const palette: MaterialYouPalette = {
  primary: "#6750A4FF",
  onPrimary: "#FFFFFFFF",
  primaryContainer: "#EADDFFFF",
  onPrimaryContainer: "#21005DFF",
  inversePrimary: "#D0BCFFFF",
  secondaryContainer: "#E8DEF8FF",
  onSecondaryContainer: "#1D192BFF",
  tertiary: "#7D5260FF",
  tertiaryContainer: "#FFD8E4FF",
  onTertiaryContainer: "#31111DFF",
  surface: "#FFFBFEFF",
  onSurface: "#1C1B1FFF",
  onSurfaceVariant: "#49454FFF",
  surfaceContainer: "#F3EDF7FF",
  surfaceContainerHigh: "#ECE6F0FF",
  surfaceContainerHighest: "#E6E0E9FF",
  surfaceContainerLow: "#F7F2FAFF",
  surfaceContainerLowest: "#FFFFFFFF",
  errorContainer: "#F9DEDCFF",
  onErrorContainer: "#410E0BFF",
  outline: "#79747EFF",
  outlineVariant: "#CAC4D0FF",
  scrim: "#000000FF",
};

describe("Material You system colors", () => {
  it.each(["light", "dark"] as const)(
    "recomputes %s semantic colors from system roles while retaining base stop red",
    (appearance) => {
      const base = getMobileThemeRuntimeVariables("goat-code", appearance, "android");
      const system =
        appearance === "dark"
          ? {
              ...palette,
              primary: "#D0BCFFFF",
              onSurface: "#E6E0E9FF",
              surface: "#141218FF",
              onSurfaceVariant: "#CAC4D0FF",
              onErrorContainer: "#F9DEDCFF",
            }
          : palette;
      const variables = materialYouPaletteToMobileThemeVariables(system, appearance, base);
      const send = variables["--color-composer-send"];
      expect(send).not.toBe(base["--color-composer-send"]);
      for (const offset of [1, 3, 5]) {
        expect(Number.parseInt(send.slice(offset, offset + 2), 16)).toBeLessThan(
          Number.parseInt(system.primary.slice(offset, offset + 2), 16),
        );
      }
      expect(variables["--color-composer-stop"]).toBe(base["--color-composer-stop"]);
      expect(variables["--color-composer-stop-foreground"]).toBe("#ffffff");
      for (const token of [
        "pr-open",
        "pr-closed",
        "pr-merged",
        "goat-avatar",
        "goat-avatar-border",
        "goat-avatar-foreground",
      ] as const) {
        expect(variables[`--color-${token}`]).not.toBe(base[`--color-${token}`]);
      }
      for (const state of ["open", "closed", "merged"] as const) {
        expect(variables[`--color-pr-${state}-surface`]).toMatch(
          appearance === "dark" ? /, 0\.16\)$/ : /, 0\.12\)$/,
        );
        expect(variables[`--color-pr-${state}-surface`]).not.toBe(
          base[`--color-pr-${state}-surface`],
        );
      }
      const neutral = materialYouPaletteToMobileThemeVariables(
        {
          ...system,
          onSurface: "#FFFFFFFF",
          surface: "#000000FF",
          onSurfaceVariant: "#000000FF",
          onErrorContainer: "#FFFFFFFF",
        },
        appearance,
        base,
      );
      expect(neutral["--color-pr-closed"]).toBe("#717171");
      expect(neutral["--color-goat-avatar"]).toBe("#010101");
      expect(neutral["--color-goat-avatar-border"]).toBe("#060606");
      expect(neutral["--color-goat-avatar-foreground"]).toBe("#c4c4c4");
    },
  );
});

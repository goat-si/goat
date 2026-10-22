import { renderDefaultThemeVariablesJSON } from "./generate-uniwind-themes.mts";
import { readDefaultMobileThemeVariables } from "../src/lib/mobileTheme.test-support";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { customThemeNames, renderUniwindThemesCSS } from "./generate-uniwind-themes.mts";

describe("generate mobile Uniwind themes", () => {
  it("keeps channel identity colors independent of the selected palette", () => {
    for (const [, name, body] of renderUniwindThemesCSS().matchAll(
      /@variant ([\w-]+) \{([^}]+)\}/gu,
    )) {
      const dark = name === "dark" || name!.endsWith("-dark");
      expect(body).toContain(
        `--color-channel-dev: ${dark ? "oklch(70.7% 0.165 254.624)" : "oklch(48.8% 0.243 264.376)"};`,
      );
      expect(body).toContain(
        `--color-channel-nightly: ${dark ? "oklch(78.5% 0.115 274.713)" : "oklch(51.1% 0.262 276.966)"};`,
      );
      expect(body).toContain(
        `--color-channel-dev-surface: ${dark ? "oklch(70.7% 0.165 254.624 / 10%)" : "oklch(48.8% 0.243 264.376 / 10%)"};`,
      );
      expect(body).toContain(
        `--color-channel-nightly-surface: ${dark ? "oklch(78.5% 0.115 274.713 / 10%)" : "oklch(51.1% 0.262 276.966 / 10%)"};`,
      );
    }
  });

  it("keeps the default runtime bridge and generated CSS on the same palette", () => {
    const variables = JSON.parse(renderDefaultThemeVariablesJSON());

    expect(variables.light).toEqual(readDefaultMobileThemeVariables("light"));
    expect(variables.dark).toEqual(readDefaultMobileThemeVariables("dark"));
    expect(variables.light["--color-screen"]).toBe("#fcfcfc");
    expect(variables.light["--color-drawer"]).toBe("#fafafa");
    expect(variables.dark["--color-screen"]).toBe("#171717");
    expect(variables.dark["--color-drawer"]).toBe("#0f0f0f");
    expect(Object.keys(variables.light)).toEqual(Object.keys(variables.dark));
  });

  it("gives every theme the same variables and a fixed Clerk palette for its appearance", () => {
    const css =
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../global.css"), "utf8") +
      renderUniwindThemesCSS();
    const themes = new Map<string, Map<string, string>>(
      ["light", "dark", ...customThemeNames].map((name) => [name, new Map()]),
    );
    for (const [, name, body] of css.matchAll(/@variant ([\w-]+) \{([^}]+)\}/gu)) {
      const variables = themes.get(name!);
      for (const [, variable, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
        variables?.set(variable!, value!.trim().toLowerCase());
      }
    }

    const lightVariables = themes.get("light")!;
    for (const [name, variables] of themes) {
      expect([...variables.keys()].sort(), name).toEqual([...lightVariables.keys()].sort());
      const isDark = name === "dark" || name.endsWith("-dark");
      expect(
        Object.fromEntries(
          [...variables].filter(([variable]) => variable.startsWith("--color-clerk-")),
        ),
        name,
      ).toEqual({
        "--color-clerk-page": isDark ? "#171717" : "#fcfcfc",
        "--color-clerk-foreground": isDark ? "#f5f5f5" : "#27272a",
        "--color-clerk-foreground-muted": isDark ? "#a1a1a1" : "#71717b",
        "--color-clerk-border": isDark ? "#2e2e2e" : "#e4e4e7",
        "--color-clerk-danger": isDark ? "#ff6467" : "#c10007",
      });
    }
  });
});

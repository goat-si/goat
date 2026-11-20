import { expect, it, vi } from "vite-plus/test";
import { render } from "../test/render";
import { migratingStorage } from "@goat/client-runtime/storage-migration";
import { setAppearanceMode, setTheme, useTheme } from "./hooks/useTheme";
import {
  getDefaultThemeColors,
  installCustomTheme,
  removeCustomThemes,
  THEME_HALVES_STORAGE_KEY,
} from "./themePalette";
import { ThemeCssRejectionNotice } from "./themeCssRejection";

function CurrentTheme() {
  const theme = useTheme();
  return (
    <>
      <ThemeCssRejectionNotice />
      <span>{JSON.stringify(theme.themeHalves)}</span>
    </>
  );
}

it("restores both previously valid halves when the other half fails on a mode switch", async () => {
  installCustomTheme({
    id: "bad-half",
    label: "Bad",
    appearance: "dark",
    colors: getDefaultThemeColors("dark"),
    css: '[data-slot="sidebar"]{position:fixed}',
  });
  try {
    setTheme("grove");
    localStorage.setItem(
      THEME_HALVES_STORAGE_KEY,
      JSON.stringify({ light: "grove", dark: "ember" }),
    );
    setAppearanceMode("light");
    await using screen = await render(<CurrentTheme />);
    localStorage.setItem(
      THEME_HALVES_STORAGE_KEY,
      JSON.stringify({ light: "grove", dark: "bad-half" }),
    );
    setAppearanceMode("dark");
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await vi.waitFor(() =>
      expect(
        JSON.parse(migratingStorage(localStorage).getItem(THEME_HALVES_STORAGE_KEY) ?? "null"),
      ).toEqual({ light: "grove", dark: "ember" }),
    );
  } finally {
    setTheme("system");
    removeCustomThemes(["bad-half"]);
  }
});

it("restores the last valid pair when an invalid stored half is encountered at startup", async () => {
  installCustomTheme({
    id: "bad-startup",
    label: "Bad startup",
    appearance: "dark",
    colors: getDefaultThemeColors("dark"),
    css: '[data-slot="sidebar"]{position:fixed}',
  });
  try {
    setTheme("grove");
    localStorage.setItem(
      THEME_HALVES_STORAGE_KEY,
      JSON.stringify({ light: "grove", dark: "ember" }),
    );
    setAppearanceMode("light");
    migratingStorage(localStorage).setItem(
      THEME_HALVES_STORAGE_KEY,
      JSON.stringify({ light: "grove", dark: "bad-startup" }),
    );
    migratingStorage(localStorage).setItem("goat:theme-appearance-mode", "dark");
    vi.resetModules();
    const startupModule = new URL("./hooks/useTheme.ts?startup-recovery", import.meta.url).href;
    await import(/* @vite-ignore */ startupModule);
    await vi.waitFor(() =>
      expect(
        JSON.parse(migratingStorage(localStorage).getItem(THEME_HALVES_STORAGE_KEY) ?? "null"),
      ).toEqual({ light: "grove", dark: "ember" }),
    );
  } finally {
    setTheme("system");
    removeCustomThemes(["bad-startup"]);
  }
});

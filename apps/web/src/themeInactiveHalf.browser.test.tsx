import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useState, type ReactNode } from "react";
import { render } from "../test/render";
import { getDefaultThemeColors, installCustomTheme, removeCustomThemes } from "./themePalette";
import { useCustomThemes } from "./hooks/useCustomThemes";
import { setAppearanceMode, setTheme, useTheme } from "./hooks/useTheme";
import { ThemeLibrary } from "./components/settings/ThemeSettings";
import { ThemeCssRejectionNotice } from "./themeCssRejection";
import "./index.css";

vi.mock("./components/settings/settingsLayout", () => ({
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  ),
}));
vi.mock("./components/settings/ThemeImportDialog", () => ({ ThemeImportDialog: () => null }));

function Appearance() {
  const theme = useTheme();
  const customThemes = useCustomThemes();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ThemeCssRejectionNotice />
      <ThemeLibrary
        appearanceMode={theme.appearanceMode}
        customThemes={customThemes}
        initialAppearance={theme.resolvedTheme}
        isImportOpen={open}
        refreshTheme={theme.refreshTheme}
        setAppearanceMode={theme.setAppearanceMode}
        setTheme={theme.setTheme}
        setThemeHalf={theme.setThemeHalf}
        theme={theme.theme}
        themeHalves={theme.themeHalves}
        onImportOpenChange={setOpen}
      />
    </>
  );
}

it("rejects an unsafe inactive dark half without storing or marking it active", async () => {
  installCustomTheme({
    id: "unsafe-inactive",
    label: "Unsafe inactive",
    appearance: "dark",
    colors: getDefaultThemeColors("dark"),
    css: '[data-slot="sidebar"]{background:url(https://evil.example/x)}',
  });
  try {
    setTheme("grove");
    setAppearanceMode("light");
    await using screen = await render(<Appearance />);
    const trigger = screen.getByRole("button", { name: /^Theme:/ });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Unsafe inactive/ }));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(trigger).toHaveAccessibleName("Theme: Grove");
    expect(document.documentElement.dataset.themeId).toBe("grove");
    expect(localStorage.getItem("goat:theme-halves:v1")).not.toContain("unsafe-inactive");
    await userEvent.click(trigger);
    await expect
      .element(screen.getByRole("menuitemradio", { name: /Unsafe inactive/ }))
      .toHaveAttribute("aria-checked", "false");
  } finally {
    setTheme("system");
    removeCustomThemes(["unsafe-inactive"]);
  }
});

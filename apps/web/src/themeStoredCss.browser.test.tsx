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

it("rejects an unsafe stored theme visibly and keeps the previous theme", async () => {
  const colors = getDefaultThemeColors("dark");
  installCustomTheme({
    id: "unsafe-test",
    label: "Unsafe",
    appearance: "dark",
    colors,
    css: '[data-slot="sidebar"]{background:url(https://evil.example/x)}',
  });
  installCustomTheme({
    id: "safe-test",
    label: "Safe",
    appearance: "dark",
    colors,
    css: '[data-slot="sidebar"]{color:red}',
  });
  try {
    setTheme("grove");
    setAppearanceMode("dark");
    await using screen = await render(<Appearance />);
    const trigger = screen.getByRole("button", { name: /^Theme:/ });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Unsafe/ }));
    await expect
      .element(
        screen.getByText(
          "Images in theme CSS are not supported. Use the background setting instead.",
        ),
      )
      .toBeVisible();
    await expect.element(trigger).toHaveAccessibleName("Theme: Grove");
    expect(document.documentElement.dataset.themeId).toBe("grove");
    await userEvent.click(trigger);
    await expect
      .element(screen.getByRole("menuitemradio", { name: /Unsafe/ }))
      .toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Safe/ }));
    await expect
      .element(trigger)
      .toHaveAccessibleName("Theme: Grove for light mode, Safe for dark mode");
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe("safe-test"));
  } finally {
    setTheme("system");
    removeCustomThemes(["unsafe-test", "safe-test"]);
  }
});

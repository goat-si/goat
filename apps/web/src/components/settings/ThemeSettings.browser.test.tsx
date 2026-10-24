import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useState, type ReactNode } from "react";
import { render } from "../../../test/render";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import {
  GROVE_THEME,
  getThemeColorsForMode,
  installCustomTheme,
  removeCustomThemes,
} from "../../themePalette";
import { searchSettings } from "./settingsSearch";
import { useThemeEditorStore } from "./themeEditorStore";
import { ThemeLibrary } from "./ThemeSettings";
import "../../index.css";

// The production row also subscribes to server permissions unrelated to a device preference.
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    id,
    title,
    description,
    control,
  }: {
    id: string;
    title: string;
    description: string;
    control: ReactNode;
  }) => (
    <div id={id}>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));
// The real dialog fetches the Open VSX catalog when it opens; only its open state matters here.
vi.mock("./ThemeImportDialog", () => ({
  ThemeImportDialog: ({ open }: { open: boolean }) =>
    open ? <div aria-label="Add theme" role="dialog" /> : null,
}));

function Appearance() {
  const theme = useTheme();
  const customThemes = useCustomThemes();
  const [isImportOpen, setIsImportOpen] = useState(false);
  return (
    <ThemeLibrary
      appearanceMode={theme.appearanceMode}
      customThemes={customThemes}
      initialAppearance={theme.resolvedTheme}
      isImportOpen={isImportOpen}
      refreshTheme={theme.refreshTheme}
      setAppearanceMode={theme.setAppearanceMode}
      setTheme={theme.setTheme}
      setThemeHalf={theme.setThemeHalf}
      theme={theme.theme}
      themeHalves={theme.themeHalves}
      onImportOpenChange={setIsImportOpen}
    />
  );
}

function themeTrigger(screen: Awaited<ReturnType<typeof render>>) {
  return screen.getByRole("button", { name: /^Theme:/ });
}

it("keeps the search targets and switches color scheme from the keyboard", async () => {
  await using screen = await render(<Appearance />);
  for (const query of ["color scheme", "themes"]) {
    const [result] = searchSettings(query);
    expect(result?.to).toBe("/settings/appearance");
    expect(document.getElementById(result?.id ?? "")).not.toBeNull();
  }

  const scheme = screen.getByRole("combobox", { name: "Color scheme" });
  await userEvent.click(scheme);
  await userEvent.click(screen.getByRole("option", { name: "Light" }));
  await expect.element(scheme).toHaveTextContent("Light");

  (scheme.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("option", { name: "Dark" })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(scheme).toHaveTextContent("Dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await userEvent.click(scheme);
  await userEvent.click(screen.getByRole("option", { name: "System" }));
  await expect.element(scheme).toHaveTextContent("System");
});

it("selects a theme for both modes, then a different theme for dark mode only", async () => {
  await using screen = await render(<Appearance />);
  await userEvent.click(themeTrigger(screen));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /Grove/ }));
  await expect.element(themeTrigger(screen)).toHaveAccessibleName("Theme: Grove");

  await userEvent.click(themeTrigger(screen));
  await expect
    .element(screen.getByRole("menuitemradio", { name: /Grove/ }))
    .toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitem", { name: /For dark mode/ }));
  await userEvent.click(
    screen.getByRole("group", { name: "Dark mode theme" }).getByRole("menuitemradio", {
      name: /Ember/,
    }),
  );
  await expect
    .element(themeTrigger(screen))
    .toHaveAccessibleName("Theme: Grove for light mode, Ember for dark mode");

  await userEvent.click(themeTrigger(screen));
  const themes = screen.getByRole("group", { name: "Themes" });
  await expect
    .element(themes.getByRole("menuitemradio", { name: /^Grove\s*, used for light mode$/ }))
    .toHaveAttribute("aria-checked", "false");
  await expect
    .element(themes.getByRole("menuitemradio", { name: /^Ember\s*, used for dark mode$/ }))
    .toBeVisible();
  await userEvent.click(themes.getByRole("menuitemradio", { name: /GOAT/ }));
  await expect.element(themeTrigger(screen)).toHaveAccessibleName("Theme: GOAT");
});

it("reaches create, add, duplicate, edit, and remove from the theme menu", async () => {
  const darkColors = getThemeColorsForMode(GROVE_THEME, "dark");
  if (!darkColors) throw new Error("Grove has no dark palette");
  installCustomTheme({ id: "dusk", label: "Dusk", appearance: "dark", colors: darkColors });
  using _theme = { [Symbol.dispose]: () => removeCustomThemes(["dusk"]) };
  using _editor = { [Symbol.dispose]: () => useThemeEditorStore.getState().closeThemeEditor() };
  await using screen = await render(<Appearance />);
  const session = () => useThemeEditorStore.getState().session;

  await userEvent.click(themeTrigger(screen));
  await expect
    .element(screen.getByRole("menuitemradio", { name: /Dusk/ }).getByText("Dark only"))
    .toBeVisible();
  await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate Grove" }));
  expect(session()).toMatchObject({ editingThemeId: null, seedName: "Grove copy" });

  await userEvent.click(themeTrigger(screen));
  await userEvent.click(screen.getByRole("menuitem", { name: "More actions for Dusk" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(session()).toMatchObject({ editingThemeId: "dusk" });

  await userEvent.click(themeTrigger(screen));
  await userEvent.click(screen.getByRole("menuitem", { name: "Create theme…" }));
  expect(session()).toMatchObject({ editingThemeId: null, seedName: null });

  await userEvent.click(themeTrigger(screen));
  await userEvent.click(screen.getByRole("menuitem", { name: "Add theme…" }));
  await expect.element(screen.getByRole("dialog", { name: "Add theme" })).toBeInTheDocument();

  await userEvent.click(themeTrigger(screen));
  await userEvent.click(screen.getByRole("menuitem", { name: "More actions for Dusk" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Remove…" }));
  await expect.element(screen.getByRole("alertdialog", { name: "Remove “Dusk”?" })).toBeVisible();
});

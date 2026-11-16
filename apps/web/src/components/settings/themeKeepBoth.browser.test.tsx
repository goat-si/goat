import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
} from "../../themePalette";
import { ThemeImportDialog } from "./ThemeImportDialog";

vi.mock("../../validateThemeCssForSave", () => ({
  validateThemeCssForSave: async (css: string) =>
    (await import("@goat/shared/themeCssSanitizer")).sanitizeThemeCss(css),
}));

it.each(["paste", "file"])(
  "keeps CSS but not collection membership when copying an imported theme from %s",
  async (source) => {
    const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
    invalidateCustomThemes();
    using _restore = {
      [Symbol.dispose]: () => {
        if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
        invalidateCustomThemes();
      },
    };
    const css = '[data-slot="sidebar"]{color:red}';
    const file = {
      version: THEME_FILE_VERSION,
      name: "Nightfall",
      appearance: "dark",
      colors: { canvas: "#112233" },
      css,
      collection: { id: "collection", label: "Collection" },
    };
    installCustomTheme(parseThemeFile(file));
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const json = JSON.stringify(file);
    if (source === "file") {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("Missing file input");
      await userEvent.upload(
        input,
        new File([json], "Different name.json", { type: "application/json" }),
      );
      await expect.element(page.getByRole("textbox", { name: "Theme JSON" })).toHaveValue(json);
    } else await page.getByRole("textbox", { name: "Theme JSON" }).fill(json);
    await page.getByRole("button", { name: "Add theme", exact: true }).click();
    await page.getByRole("button", { name: "Keep both" }).click();
    const copy = getCustomThemes().find((candidate) => candidate.id !== "nightfall");
    expect(copy?.css).toContain("[data-goat-theme-root]");
    expect(copy?.collection).toBeUndefined();
  },
);

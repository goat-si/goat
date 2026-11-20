import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../test/render";
import {
  getDefaultThemeColors,
  installCustomTheme,
  removeCustomThemes,
  updateCustomTheme,
} from "./themePalette";
import { setTheme, useTheme } from "./hooks/useTheme";
import { ThemeCssRejectionNotice } from "./themeCssRejection";

const calls = vi.hoisted(() => ({ invalid: 0 }));
vi.mock("@goat/shared/themeCssSanitizer", () => ({
  sanitizeThemeCss: (css: string) => {
    if (css.includes("position:fixed")) {
      calls.invalid++;
      if (calls.invalid <= 2) throw new Error("Unsupported property");
    }
    return css;
  },
}));

function ThemeControl() {
  const theme = useTheme();
  return (
    <>
      <ThemeCssRejectionNotice />
      <button onClick={() => theme.refreshTheme()}>Refresh</button>
    </>
  );
}

it("falls back when the last valid theme itself becomes invalid", async () => {
  const theme = {
    id: "edited-invalid",
    label: "Edited",
    appearance: "dark" as const,
    colors: getDefaultThemeColors("dark"),
    css: '[data-slot="sidebar"]{color:red}',
  };
  calls.invalid = 0;
  installCustomTheme(theme);
  try {
    setTheme(theme.id);
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(theme.id));
    await using screen = await render(<ThemeControl />);
    updateCustomTheme({ ...theme, css: '[data-slot="sidebar"]{position:fixed}' });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).not.toBe(theme.id));
    expect(calls.invalid).toBeLessThanOrEqual(2);
  } finally {
    setTheme("system");
    removeCustomThemes([theme.id]);
  }
});

import { expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { migratingStorage } from "@goat/client-runtime/storage-migration";
import { render } from "../test/render";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  getDefaultThemeColors,
  getThemeDefinition,
  installCustomTheme,
  removeCustomThemes,
  updateCustomTheme,
} from "./themePalette";
import { setTheme } from "./hooks/useTheme";
import { ThemeCssRejectionNotice } from "./themeCssRejection";

vi.mock("./state/desktopHostEnvironment", () => ({
  themeEnvironmentIdAtom: Atom.make("env-default-validation"),
}));
vi.mock("./state/server", () => ({
  themeServerSettingsAtom: Atom.make({
    defaultTheme: "",
    defaultThemeSetAt: "",
    defaultAppearance: "",
    defaultAppearanceSetAt: "",
  }),
}));
import { themeEnvironmentIdAtom } from "./state/desktopHostEnvironment";
import { themeServerSettingsAtom } from "./state/server";
import { startDefaultThemeAdoption } from "./hooks/useDefaultTheme";

const envAtom = themeEnvironmentIdAtom as unknown as ReturnType<typeof Atom.make<string>>;
const settingsAtom = themeServerSettingsAtom as unknown as ReturnType<
  typeof Atom.make<{
    defaultTheme: string;
    defaultThemeSetAt: string;
    defaultAppearance: string;
    defaultAppearanceSetAt: string;
  }>
>;
const theme = {
  id: "default-css-test",
  label: "Default CSS",
  appearance: "dark" as const,
  colors: getDefaultThemeColors("dark"),
  css: '[data-slot="sidebar"]{position:fixed}',
};

it("does not record a rejected default and applies a corrected publication", async () => {
  const env = "env-rejected-default";
  const key = `goat:default-theme-applied:v2:${env}`;
  migratingStorage(localStorage).removeItem(key);
  setTheme("grove");
  const unpinEnv = appAtomRegistry.subscribe(envAtom, () => {});
  const unpinSettings = appAtomRegistry.subscribe(settingsAtom, () => {});
  installCustomTheme(theme);
  appAtomRegistry.set(envAtom, env);
  appAtomRegistry.set(settingsAtom, {
    defaultTheme: theme.id,
    defaultThemeSetAt: "one",
    defaultAppearance: "",
    defaultAppearanceSetAt: "",
  });
  expect(getThemeDefinition(theme.id)?.css).toBe(theme.css);
  expect(appAtomRegistry.get(settingsAtom).defaultTheme).toBe(theme.id);
  try {
    await using screen = await render(<ThemeCssRejectionNotice />);
    const stop = startDefaultThemeAdoption();
    try {
      await expect.element(screen.getByRole("alert")).toBeVisible();
      expect(migratingStorage(localStorage).getItem(key)).toBeNull();
      updateCustomTheme({ ...theme, css: '[data-slot="sidebar"]{color:red}' });
      await vi.waitFor(() =>
        expect(migratingStorage(localStorage).getItem(key)).toBe(`${theme.id}@one`),
      );
      await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe(theme.id));
    } finally {
      stop();
    }
  } finally {
    unpinEnv();
    unpinSettings();
    setTheme("system");
    removeCustomThemes([theme.id]);
  }
});

it("does not record a default superseded by a later local selection", async () => {
  const env = "env-superseded-default";
  const key = `goat:default-theme-applied:v2:${env}`;
  migratingStorage(localStorage).removeItem(key);
  const unpinEnv = appAtomRegistry.subscribe(envAtom, () => {});
  const unpinSettings = appAtomRegistry.subscribe(settingsAtom, () => {});
  installCustomTheme({ ...theme, css: '[data-slot="sidebar"]{color:red}' });
  appAtomRegistry.set(envAtom, env);
  appAtomRegistry.set(settingsAtom, {
    defaultTheme: theme.id,
    defaultThemeSetAt: "two",
    defaultAppearance: "",
    defaultAppearanceSetAt: "",
  });
  const stop = startDefaultThemeAdoption();
  try {
    setTheme("ember");
    await vi.waitFor(() => expect(document.documentElement.dataset.themeId).toBe("ember"));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(migratingStorage(localStorage).getItem(key)).toBeNull();
    expect(document.documentElement.dataset.themeId).toBe("ember");
  } finally {
    stop();
    unpinEnv();
    unpinSettings();
    setTheme("system");
    removeCustomThemes([theme.id]);
  }
});

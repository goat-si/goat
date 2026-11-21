import { expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  setTheme: vi.fn(() => true),
  setAppearanceMode: vi.fn(() => true),
  appearanceMode: "dark",
}));
vi.mock("../state/desktopHostEnvironment", () => ({
  themeEnvironmentIdAtom: Atom.make("env-stock"),
}));
vi.mock("../state/server", () => ({
  themeServerSettingsAtom: Atom.make({
    defaultTheme: "",
    defaultThemeSetAt: "first",
    defaultAppearance: "",
    defaultAppearanceSetAt: "",
  }),
}));
vi.mock("../themePalette", () => ({
  getThemeDefinition: () => null,
  singleAppearanceOf: () => null,
  subscribeToCustomThemes: () => () => {},
}));
vi.mock("./useTheme", () => ({
  setTheme: state.setTheme,
  setAppearanceMode: state.setAppearanceMode,
  getThemeSnapshot: () => ({ appearanceMode: state.appearanceMode }),
}));

import { themeServerSettingsAtom } from "../state/server";
import { startDefaultThemeAdoption } from "./useDefaultTheme";
const settingsAtom = themeServerSettingsAtom as unknown as ReturnType<
  typeof Atom.make<{
    defaultTheme: string;
    defaultThemeSetAt: string;
    defaultAppearance: string;
    defaultAppearanceSetAt: string;
  }>
>;

it("applies a dated stock reset once and preserves a later local selection", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  state.setTheme.mockClear();
  state.appearanceMode = "dark";
  const stop = startDefaultThemeAdoption();
  try {
    expect(state.setTheme).toHaveBeenCalledExactlyOnceWith("dark");
    state.appearanceMode = "light";
    appAtomRegistry.set(settingsAtom, {
      defaultTheme: "",
      defaultThemeSetAt: "first",
      defaultAppearance: "",
      defaultAppearanceSetAt: "",
    });
    expect(state.setTheme).toHaveBeenCalledTimes(1);
    appAtomRegistry.set(settingsAtom, {
      defaultTheme: "",
      defaultThemeSetAt: "second",
      defaultAppearance: "",
      defaultAppearanceSetAt: "",
    });
    expect(state.setTheme).toHaveBeenLastCalledWith("light");
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

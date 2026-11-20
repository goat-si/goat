import { expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  setAppearanceMode: vi.fn(() => true),
  setTheme: vi.fn(() => true),
}));
vi.mock("../state/desktopHostEnvironment", () => ({
  themeEnvironmentIdAtom: Atom.make("env-adoption"),
}));
vi.mock("../state/server", () => ({
  themeServerSettingsAtom: Atom.make({
    defaultTheme: "",
    defaultThemeSetAt: "",
    defaultAppearance: "dark",
    defaultAppearanceSetAt: "first",
  }),
}));
vi.mock("../themePalette", () => ({
  getThemeDefinition: () => null,
  singleAppearanceOf: () => null,
  subscribeToCustomThemes: () => () => {},
}));
vi.mock("./useTheme", () => ({
  setAppearanceMode: state.setAppearanceMode,
  setTheme: state.setTheme,
}));

import { themeServerSettingsAtom } from "../state/server";
import { startDefaultThemeAdoption } from "./useDefaultTheme";

const testSettingsAtom = themeServerSettingsAtom as unknown as ReturnType<
  typeof Atom.make<{
    defaultTheme: string;
    defaultThemeSetAt: string;
    defaultAppearance: string;
    defaultAppearanceSetAt: string;
  }>
>;

it("does not replay an applied appearance over a later local choice", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  state.setAppearanceMode.mockClear();
  const stop = startDefaultThemeAdoption();
  try {
    expect(state.setAppearanceMode).toHaveBeenCalledExactlyOnceWith("dark");
    appAtomRegistry.set(testSettingsAtom, {
      defaultTheme: "",
      defaultThemeSetAt: "",
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "first",
    });
    expect(state.setAppearanceMode).toHaveBeenCalledTimes(1);
    appAtomRegistry.set(testSettingsAtom, {
      defaultTheme: "",
      defaultThemeSetAt: "",
      defaultAppearance: "light",
      defaultAppearanceSetAt: "second",
    });
    expect(state.setAppearanceMode).toHaveBeenLastCalledWith("light");
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

it("does not replay an appearance when storage is unavailable", () => {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  });
  state.setAppearanceMode.mockClear();
  appAtomRegistry.set(testSettingsAtom, {
    defaultTheme: "",
    defaultThemeSetAt: "",
    defaultAppearance: "dark",
    defaultAppearanceSetAt: "blocked-storage",
  });
  const stop = startDefaultThemeAdoption();
  try {
    expect(state.setAppearanceMode).toHaveBeenCalledExactlyOnceWith("dark");
    appAtomRegistry.set(testSettingsAtom, {
      defaultTheme: "",
      defaultThemeSetAt: "",
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "blocked-storage",
    });
    expect(state.setAppearanceMode).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

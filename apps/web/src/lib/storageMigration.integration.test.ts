// @vitest-environment jsdom
import * as NodeVM from "node:vm";
import html from "../../index.html?raw";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage, resolveStorage } from "./storage";

const bootScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.themeId;
  document.head.innerHTML = "<meta name='theme-color'>";
});

describe("browser storage migration integration", () => {
  it("hydrates persist middleware from the old namespace and writes only the new one", () => {
    const base = createMemoryStorage();
    const legacy = "t3code:diff-panel-state:v1"; // goat-rename: legacy
    const key = "goat:diff-panel-state:v1";
    const original = JSON.stringify({ state: { open: true }, version: 0 });
    base.setItem(legacy, original);
    const store = createStore(
      persist(() => ({ open: false }), {
        name: key,
        storage: createJSONStorage(() => resolveStorage(base)),
      }),
    );
    expect(store.getState().open).toBe(true);
    store.setState({ open: false });
    expect(JSON.parse(base.getItem(key) as string).state.open).toBe(false);
    expect(base.getItem(legacy)).toBe(original);
  });

  it("applies legacy theme and appearance preferences before React mounts", () => {
    window.localStorage.setItem("t3code:theme", "t3-ocean"); // goat-rename: legacy
    window.localStorage.setItem("t3code:theme-appearance-mode", "light"); // goat-rename: legacy
    NodeVM.runInNewContext(bootScript!, {
      window: { localStorage: window.localStorage, matchMedia: () => ({ matches: true }) },
      document: window.document,
    });
    expect(window.document.documentElement.dataset.themeId).toBe("ocean");
    expect(window.document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("goat:theme")).toBe("t3-ocean"); // goat-rename: legacy
    expect(window.localStorage.getItem("t3code:theme")).toBe("t3-ocean"); // goat-rename: legacy
  });

  it("prefers the GOAT boot preference over the old theme", () => {
    window.localStorage.setItem("t3code:theme", "t3-ocean"); // goat-rename: legacy
    window.localStorage.setItem("goat:theme", "grove");
    NodeVM.runInNewContext(bootScript!, {
      window: { localStorage: window.localStorage, matchMedia: () => ({ matches: false }) },
      document: window.document,
    });
    expect(window.document.documentElement.dataset.themeId).toBe("grove");
    expect(window.localStorage.getItem("t3code:theme")).toBe("t3-ocean"); // goat-rename: legacy
  });
});

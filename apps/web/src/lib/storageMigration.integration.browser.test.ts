import html from "../../index.html?raw";
import { describe, expect, it } from "vite-plus/test";
import { createStore } from "zustand/vanilla";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage, resolveStorage } from "./storage";

const bootScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function runBootScript(
  fakeWindow: {
    localStorage: Storage;
    matchMedia: () => { matches: boolean };
  },
  doc: Document,
) {
  new Function("window", "document", bootScript!)(fakeWindow, doc);
}

function setup() {
  window.localStorage.clear();
  const doc = document.implementation.createHTMLDocument();
  doc.head.innerHTML = "<meta name='theme-color'>";
  return { document: doc, [Symbol.dispose]: () => window.localStorage.clear() };
}

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
    using test = setup();
    window.localStorage.setItem("t3code:theme", "t3-ocean"); // goat-rename: legacy
    window.localStorage.setItem("t3code:theme-appearance-mode", "light"); // goat-rename: legacy
    runBootScript(
      { localStorage: window.localStorage, matchMedia: () => ({ matches: true }) },
      test.document,
    );
    expect(test.document.documentElement.dataset.themeId).toBe("ocean");
    expect(test.document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("goat:theme")).toBe("t3-ocean"); // goat-rename: legacy
    expect(window.localStorage.getItem("t3code:theme")).toBe("t3-ocean"); // goat-rename: legacy
  });

  it("prefers the GOAT boot preference over the old theme", () => {
    using test = setup();
    window.localStorage.setItem("t3code:theme", "t3-ocean"); // goat-rename: legacy
    window.localStorage.setItem("goat:theme", "grove");
    runBootScript(
      { localStorage: window.localStorage, matchMedia: () => ({ matches: false }) },
      test.document,
    );
    expect(test.document.documentElement.dataset.themeId).toBe("grove");
    expect(window.localStorage.getItem("t3code:theme")).toBe("t3-ocean"); // goat-rename: legacy
  });
});

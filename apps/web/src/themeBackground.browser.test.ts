import { expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { EnvironmentId } from "@goat/contracts";
import { appAtomRegistry } from "./rpc/atomRegistry";
import "./index.css";

const state = vi.hoisted(() => ({
  mint: vi.fn(),
  mintInput: vi.fn(),
  themeListener: () => {},
  libraryListener: () => {},
  selected: null as unknown,
  published: null as unknown,
  authoritative: null as unknown,
}));
vi.mock("@goat/client-runtime/state/runtime", async (original) => ({
  ...(await original()),
  createEnvironmentRpcQueryAtomFamily: () => (input: unknown) => {
    state.mintInput(input);
    return {};
  },
  executeAtomQuery: state.mint,
}));
vi.mock("./connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./hooks/useTheme", () => ({
  getThemeSnapshot: () => ({ theme: "nightfall", themeHalves: null, resolvedTheme: "dark" }),
  subscribeRenderedAppearance: (listener: () => void) => {
    state.themeListener = listener;
    return () => {};
  },
}));
vi.mock("./hooks/useEnvironmentTheme", () => ({
  environmentThemeDefinition: () => state.authoritative,
}));
vi.mock("./themePalette", () => ({
  getEnvironmentThemes: () => [state.published],
  getThemeDefinition: () => state.selected,
  resolveThemeHalf: (theme: string) => theme,
  subscribeToCustomThemes: (listener: () => void) => {
    state.libraryListener = listener;
    return () => {};
  },
}));
vi.mock("./state/desktopHostEnvironment", () => ({
  themeEnvironmentIdAtom: Atom.make(EnvironmentId.make("env-test")),
}));
vi.mock("./state/server", () => ({
  primaryServerEnvironmentThemesAtom: Atom.make([
    { id: "nightfall", name: "Nightfall", appearance: "dark", background: `png:${"a".repeat(64)}` },
  ]),
}));
vi.mock("./state/session", () => ({
  environmentSession: {
    preparedConnectionValueAtom: Atom.family(() =>
      Atom.make(Option.some({ httpBaseUrl: "https://goat.example" })),
    ),
  },
}));

import {
  retryThemeBackground,
  startThemeBackground,
  themeBackgroundStatus,
} from "./themeBackground";
import { environmentSession } from "./state/session";

it("loads the selected published background and releases its URL on cleanup", async () => {
  state.selected = { id: "nightfall", label: "Nightfall", appearance: "dark", colors: {} };
  state.published = state.selected;
  state.authoritative = state.selected;
  state.mint.mockClear().mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/token/background", expiresAt: 1 },
  });
  using _fetch = vi
    .spyOn(window, "fetch")
    .mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
  using _create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-background");
  using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const stop = startThemeBackground();
  try {
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("ready"));
    expect(document.documentElement.style.getPropertyValue("--theme-background-image")).toContain(
      "blob:test-background",
    );
    state.themeListener();
    expect(state.mint).toHaveBeenCalledTimes(1);
    expect(themeBackgroundStatus()).toBe("ready");
  } finally {
    stop();
  }
  expect(revoke).toHaveBeenCalledWith("blob:test-background");
  expect(document.documentElement.style.getPropertyValue("--theme-background-image")).toBe("");
});

it("clears a disconnected background and reloads it on reconnect", async () => {
  state.selected = { id: "nightfall", label: "Nightfall", appearance: "dark", colors: {} };
  state.published = state.selected;
  state.authoritative = state.selected;
  state.mint.mockClear().mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/token/background", expiresAt: 1 },
  });
  const connection = environmentSession.preparedConnectionValueAtom(
    EnvironmentId.make("env-test"),
  ) as unknown as ReturnType<typeof Atom.make<Option.Option<{ httpBaseUrl: string }>>>;
  appAtomRegistry.set(connection, Option.some({ httpBaseUrl: "https://goat.example" }));
  using _fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(
      async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
  using _create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reconnected-background");
  using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const stop = startThemeBackground();
  try {
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("ready"));
    appAtomRegistry.set(connection, Option.none());
    expect(themeBackgroundStatus()).toBe("idle");
    expect(revoke).toHaveBeenCalledWith("blob:reconnected-background");
    appAtomRegistry.set(connection, Option.some({ httpBaseUrl: "https://goat.example" }));
    await vi.waitFor(() => expect(state.mint).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("ready"));
  } finally {
    stop();
  }
});

it("never requests a background for a same-ID saved or stale published definition", () => {
  state.mint.mockClear();
  const published = { id: "nightfall", label: "Published", appearance: "dark", colors: {} };
  state.published = published;
  state.authoritative = published;
  state.selected = { ...published, label: "Saved" };
  const stop = startThemeBackground();
  try {
    expect(state.mint).not.toHaveBeenCalled();
    state.selected = published;
    state.authoritative = { ...published, label: "New published revision" };
    state.libraryListener();
    expect(state.mint).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue("--theme-background-image")).toBe("");
  } finally {
    stop();
  }
});

it("exposes an unavailable state and permits a person to retry", async () => {
  state.selected = { id: "nightfall", label: "Nightfall", appearance: "dark", colors: {} };
  state.published = state.selected;
  state.authoritative = state.selected;
  state.mint.mockClear().mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/token/background", expiresAt: 1 },
  });
  using request = vi
    .spyOn(window, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockImplementation(
      async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
  using _create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried-background");
  using _revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const stop = startThemeBackground();
  try {
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("unavailable"));
    retryThemeBackground();
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("ready"));
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("retries the intended published background when online during a preview", async () => {
  state.selected = { id: "nightfall", label: "Nightfall", appearance: "dark", colors: {} };
  state.published = state.selected;
  state.authoritative = state.selected;
  state.mint.mockClear().mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/assets/token/background", expiresAt: 1 },
  });
  state.mintInput.mockClear();
  using _fetch = vi
    .spyOn(window, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockImplementation(
      async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
    );
  using _create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:online-background");
  using _revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const previous = document.documentElement.dataset.themeId;
  const previousCanvas = document.documentElement.style.getPropertyValue("--app-theme-canvas");
  document.documentElement.style.setProperty("--app-theme-canvas", "#0c2238");
  const conversation = document.createElement("div");
  conversation.setAttribute("data-workspace-area", "conversation");
  conversation.style.backgroundColor = "rgb(12, 34, 56)";
  document.body.append(conversation);
  const stop = startThemeBackground();
  try {
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("unavailable"));
    document.documentElement.dataset.themeId = "__preview";
    state.themeListener();
    expect(getComputedStyle(conversation).backgroundColor).toBe("rgb(12, 34, 56)");
    expect(getComputedStyle(conversation).backgroundImage).not.toContain("blob:");
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(themeBackgroundStatus()).toBe("ready"));
    expect(state.mintInput).toHaveBeenLastCalledWith({
      environmentId: "env-test",
      input: { themeId: "nightfall", revision: `png:${"a".repeat(64)}` },
    });
    expect(getComputedStyle(conversation).backgroundColor).toBe("rgb(12, 34, 56)");
    expect(getComputedStyle(conversation).backgroundImage).not.toContain("blob:");
    document.documentElement.dataset.themeId = "nightfall";
    state.themeListener();
    expect(getComputedStyle(conversation).backgroundImage).toContain("blob:");
  } finally {
    conversation.remove();
    if (previousCanvas)
      document.documentElement.style.setProperty("--app-theme-canvas", previousCanvas);
    else document.documentElement.style.removeProperty("--app-theme-canvas");
    if (previous === undefined) delete document.documentElement.dataset.themeId;
    else document.documentElement.dataset.themeId = previous;
    stop();
  }
});

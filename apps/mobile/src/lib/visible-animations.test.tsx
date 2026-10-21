import { act, createElement, useState, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  focused: true,
  app: "active",
  reduced: false,
  focusListeners: new Set<() => void>(),
  appListeners: new Set<(state: string) => void>(),
  motionListeners: new Set<(value: boolean) => void>(),
  running: new Set<object>(),
  repeat: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () =>
    useSyncExternalStore(
      (listener) => {
        h.focusListeners.add(listener);
        return () => h.focusListeners.delete(listener);
      },
      () => h.focused,
    ),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  AppState: {
    get currentState() {
      return h.app;
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      h.appListeners.add(listener);
      return { remove: () => h.appListeners.delete(listener) };
    },
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(h.reduced),
    addEventListener: (_: string, listener: (value: boolean) => void) => {
      h.motionListeners.add(listener);
      return { remove: () => h.motionListeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  },
  useSharedValue: (initial: number) =>
    useState(() => {
      let value: unknown = initial;
      const shared = {
        get value() {
          return value;
        },
        set value(next: unknown) {
          value = next;
          if (next === "repeating") h.running.add(shared);
          else h.running.delete(shared);
        },
      };
      return shared;
    })[0],
  useAnimatedStyle: () => ({}),
  withRepeat: (...args: unknown[]) => {
    h.repeat(...args);
    return "repeating";
  },
  withTiming: () => "timing",
  cancelAnimation: (value: object) => {
    h.cancel(value);
    h.running.delete(value);
  },
  Easing: { out: (value: unknown) => value, inOut: (value: unknown) => value, cubic: 0, quad: 0 },
  ReduceMotion: { System: "system" },
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark", themeVariables: {} }),
}));
vi.mock("./mobileTheme", () => ({ themeColorWithAlpha: () => "transparent" }));
import { ConnectionStatusDot } from "../features/connection/ConnectionStatusDot";

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.focused = true;
  h.app = "active";
  h.reduced = false;
  h.repeat.mockClear();
  h.cancel.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  expect(h.running.size).toBe(0);
  expect(h.appListeners.size).toBe(0);
  expect(h.motionListeners.size).toBe(0);
});
async function mount() {
  await act(async () => root.render(<ConnectionStatusDot state="reconnecting" pulse />));
}
function app(state: string) {
  act(() => {
    h.app = state;
    for (const listener of h.appListeners) listener(state);
  });
}
function focus(value: boolean) {
  act(() => {
    h.focused = value;
    for (const listener of h.focusListeners) listener();
  });
}
function motion(value: boolean) {
  act(() => {
    h.reduced = value;
    for (const listener of h.motionListeners) listener(value);
  });
}

describe("connection status dot animation lifecycle", () => {
  it("cancels on background/inactive and restarts on active", async () => {
    await mount();
    expect(h.running.size).toBe(1);
    const cancellations = h.cancel.mock.calls.length;
    app("background");
    expect(h.cancel.mock.calls.length).toBeGreaterThan(cancellations);
    expect(h.running.size).toBe(0);
    app("inactive");
    expect(h.running.size).toBe(0);
    app("active");
    expect(h.running.size).toBe(1);
  });
  it("cancels on blur and restarts on focus", async () => {
    await mount();
    focus(false);
    expect(h.running.size).toBe(0);
    focus(true);
    expect(h.running.size).toBe(1);
  });
  it("cancels when reduced motion is enabled and resumes when disabled", async () => {
    await mount();
    motion(true);
    expect(h.running.size).toBe(0);
    motion(false);
    expect(h.running.size).toBe(1);
  });
  it.each(["background", "blur", "reduced"])("never starts while initially %s", async (state) => {
    h.app = state === "background" ? "background" : "active";
    h.focused = state !== "blur";
    h.reduced = state === "reduced";
    await mount();
    expect(h.repeat).not.toHaveBeenCalled();
  });
  it("cancels and removes subscriptions on unmount", async () => {
    await mount();
    expect(h.running.size).toBe(1);
    act(() => root.render(null));
    expect(h.running.size).toBe(0);
    expect(h.appListeners.size).toBe(0);
    expect(h.motionListeners.size).toBe(0);
  });
});

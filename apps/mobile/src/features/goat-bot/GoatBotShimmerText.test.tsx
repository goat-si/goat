import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const env = vi.hoisted(() => ({ active: true, reduced: false, focused: true }));
const sweep = vi.hoisted(() => ({ starts: 0, stops: 0 }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  StyleSheet: { absoluteFill: {} },
  useAnimatedValue: () => ({ setValue: () => {}, interpolate: () => 0 }),
  Animated: {
    View: ({ children }: { children?: ReactNode }) => <div data-highlight>{children}</div>,
  },
}));
vi.mock("@expo/ui/community/masked-view", () => ({
  MaskedView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => env.active,
  useReduceMotionEnabled: () => env.reduced,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => env.focused }));
vi.mock("../threads/work-shimmer-steps", () => ({
  startShimmerSteps: () => {
    sweep.starts += 1;
    return () => {
      sweep.stops += 1;
    };
  },
}));

import { GoatBotShimmerText } from "./GoatBotShimmerText";

async function renderLine() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const show = (animate: boolean) =>
    act(async () => root.render(<GoatBotShimmerText label="Copying files" animate={animate} />));
  const highlighted = () => container.querySelector("[data-highlight]") !== null;
  return { show, highlighted, unmount: () => act(async () => root.unmount()) };
}

it("runs the stepped sweep only while the line may animate and stops it on every way out", async () => {
  Object.assign(sweep, { starts: 0, stops: 0 });
  const line = await renderLine();
  try {
    await line.show(true);
    expect(sweep.starts).toBe(1);
    expect(line.highlighted()).toBe(true);

    await line.show(false);
    expect(sweep.stops).toBe(1);
    expect(line.highlighted()).toBe(false);

    await line.show(true);
    expect(sweep.starts).toBe(2);
    env.reduced = true;
    await line.show(true);
    expect(sweep.stops).toBe(2);
    expect(line.highlighted()).toBe(false);
    env.reduced = false;

    await line.show(true);
    expect(sweep.starts).toBe(3);
    env.active = false;
    await line.show(true);
    expect(sweep.stops).toBe(3);
    env.active = true;

    await line.show(true);
    expect(sweep.starts).toBe(4);
    env.focused = false;
    await line.show(true);
    expect(sweep.stops).toBe(4);
    env.focused = true;

    await line.show(true);
    expect(sweep.starts).toBe(5);
  } finally {
    Object.assign(env, { active: true, reduced: false, focused: true });
    await line.unmount();
  }
  expect(sweep.stops).toBe(5);
});

it("never starts a sweep for a line that may not animate", async () => {
  Object.assign(sweep, { starts: 0, stops: 0 });
  const line = await renderLine();
  await line.show(false);
  expect(sweep.starts).toBe(0);
  expect(line.highlighted()).toBe(false);
  await line.unmount();
});

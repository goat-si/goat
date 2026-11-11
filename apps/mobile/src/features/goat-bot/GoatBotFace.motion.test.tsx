import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { goatBotFaceMotion } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  loops: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
  timings: [] as Array<{ useNativeDriver?: boolean }>,
}));
const header = vi.hoisted(() => ({ state: "idle" }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <span aria-label={accessibilityLabel}>{children}</span>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StyleSheet: { absoluteFill: {} },
  Easing: { linear: (value: number) => value },
  useAnimatedValue: () => ({ setValue: () => {}, interpolate: () => 0 }),
  Animated: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    timing: (_value: unknown, config: { useNativeDriver?: boolean }) => {
      native.timings.push(config);
      return {};
    },
    loop: () => {
      const loop = { start: vi.fn(), stop: vi.fn() };
      native.loops.push(loop);
      return loop;
    },
  },
}));
vi.mock("react-native-reanimated", () => {
  const chain = { duration: () => chain, reduceMotion: () => chain };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    FadeIn: chain,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (props: {
    options: { title?: string; headerTitle?: () => ReactNode };
  }) => <header data-title={props.options.title}>{props.options.headerTitle?.()}</header>,
}));
vi.mock("./useMobileGoatBotFace", () => ({
  useMobileGoatBotFace: () => ({ state: header.state, since: null }),
  useMobileGoatBotFaceMotion: () => null,
}));

import { GoatBotFace, GoatBotHeaderFace } from "./GoatBotFace";

it("runs one native-driver loop while the face moves and stops it when the face stills or unmounts", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const working = goatBotFaceMotion("working");
  await act(async () => root.render(<GoatBotFace state="working" size={40} motion={working} />));
  expect(native.loops).toHaveLength(1);
  expect(native.loops[0]?.start).toHaveBeenCalledTimes(1);
  expect(native.timings.every((config) => config.useNativeDriver === true)).toBe(true);
  await act(async () => root.render(<GoatBotFace state="working" size={40} motion={null} />));
  expect(native.loops[0]?.stop).toHaveBeenCalled();
  await act(async () => root.render(<GoatBotFace state="working" size={40} motion={working} />));
  expect(native.loops).toHaveLength(2);
  await act(async () => root.unmount());
  expect(native.loops[1]?.stop).toHaveBeenCalled();
});

it("starts no loop for a still face", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.loops.length = 0;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<GoatBotFace state="idle" size={40} motion={null} />));
  expect(native.loops).toHaveLength(0);
  await act(async () => root.unmount());
});

it("names the bot's state on the header title text VoiceOver reads", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    header.state = "working";
    await act(async () => root.render(<GoatBotHeaderFace activity={null} title="GOAT Bot" />));
    const title = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "GOAT Bot",
    );
    expect(title?.getAttribute("aria-label")).toBe("GOAT Bot, Working");
  } finally {
    header.state = "idle";
    await act(async () => root.unmount());
  }
});

it("replaces the header title text when its state changes, since iOS caches a text's VoiceOver label by its text", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const labelled = () => [...container.querySelectorAll("[aria-label]")];
  try {
    header.state = "reading";
    await act(async () => root.render(<GoatBotHeaderFace activity={null} title="GOAT Bot" />));
    const [reading] = labelled();
    header.state = "finished";
    await act(async () => root.render(<GoatBotHeaderFace activity={null} title="GOAT Bot" />));
    const after = labelled();
    expect(after.map((node) => node.getAttribute("aria-label"))).toEqual(["GOAT Bot, Finished"]);
    expect(after[0]).not.toBe(reading);
  } finally {
    header.state = "idle";
    await act(async () => root.unmount());
  }
});
it("gives a member's navigation bar the member's name, not the stack's GOAT Bot title", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<GoatBotHeaderFace activity={null} title="Scout" />));
    expect(container.querySelector("header")?.getAttribute("data-title")).toBe("Scout");
  } finally {
    await act(async () => root.unmount());
  }
});
it("draws a bot's emoji avatar in the header in place of its face, keeping the state VoiceOver reads", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    header.state = "reading";
    await act(async () =>
      root.render(<GoatBotHeaderFace activity={null} title="Ada" emoji=" 🐙 " />),
    );
    const texts = [...container.querySelectorAll("span")].map((span) => span.textContent);
    expect(texts).toContain("🐙");
    const title = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "Ada",
    );
    expect(title?.getAttribute("aria-label")).toBe("Ada, Reading");
  } finally {
    header.state = "idle";
    await act(async () => root.unmount());
  }
});

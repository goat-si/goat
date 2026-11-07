import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { goatBotFaceMotion } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  loops: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
  timings: [] as Array<{ useNativeDriver?: boolean }>,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("./useMobileGoatBotFace", () => ({
  useMobileGoatBotFace: () => ({ state: "idle", since: null }),
  useMobileGoatBotFaceMotion: () => null,
}));

import { GoatBotFace } from "./GoatBotFace";

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

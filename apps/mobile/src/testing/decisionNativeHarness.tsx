import type { ReactNode } from "react";
import { vi } from "vite-plus/test";

const { Box } = vi.hoisted(() => ({
  Box: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../native/NativeScrollViewMarker", () => ({
  NativeScrollView: Box,
  NativeScrollViewMarker: Box,
}));
vi.mock("../features/home/ThreadUndoNotice", () => ({ ThreadUndoNotice: () => null }));
vi.mock("react-native-reanimated", () => ({
  default: { View: Box },
  Easing: { out: (value: unknown) => value, cubic: "cubic" },
  FadeInUp: { duration: () => ({ easing: () => undefined }) },
  FadeOutDown: { duration: () => ({ easing: () => undefined }) },
  LinearTransition: { duration: () => undefined },
  useAnimatedStyle: () => ({}),
  useDerivedValue: (value: () => number) => ({ value: value() }),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const screen = vi.hoisted(() => ({ escape: undefined as (() => void) | undefined }));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-reanimated", () => {
  const motion = { duration: () => ({ reduceMotion: () => ({}) }) };
  return {
    default: {
      View: (props: { children: ReactNode; onAccessibilityEscape?: () => void }) => {
        screen.escape = props.onAccessibilityEscape;
        return <div>{props.children}</div>;
      },
    },
    FadeIn: motion,
    FadeOut: motion,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("@react-navigation/elements", async () => {
  const { createContext } = await import("react");
  return { HeaderHeightContext: createContext<number | undefined>(undefined) };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: () => {},
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
vi.mock("@goat/client-runtime/source-control-clients", () => ({
  sourceControlClients: { findByChangeRequestUrl: () => undefined, get: () => undefined },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => {} }));
vi.mock("../../components/ui/Toast", () => ({ Toast: () => null }));
vi.mock("../../components/ui/useToolbarLayout", () => ({
  useToolbarLayout: () => ({ paddingTop: 0, height: 0, paddingBottom: 0 }),
}));
vi.mock("../../lib/designTokens", () => ({ MOBILE_MOTION: { enter: 0, exit: 0 } }));
vi.mock("../../lib/layoutMetrics", () => ({ APP_BAR_HEIGHT: 0 }));

import { GitActionProgressOverlay } from "./GitActionProgressOverlay";

it.each([
  ["running", 0],
  ["success", 1],
  ["error", 1],
] as const)(
  "a VoiceOver escape on a %s banner dismisses only a finished action's result (%i)",
  async (phase, dismissals) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const onDismiss = vi.fn();
    try {
      await act(() =>
        root.render(
          <GitActionProgressOverlay
            progress={{ phase, label: "Creating worktree", description: null }}
            onDismiss={onDismiss}
          />,
        ),
      );
      screen.escape?.();

      expect(onDismiss).toHaveBeenCalledTimes(dismissals);
    } finally {
      await act(() => root.unmount());
      screen.escape = undefined;
      vi.unstubAllGlobals();
    }
  },
);

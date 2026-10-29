import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type PanEvent = { readonly translationY: number };
type Handlers = {
  onStart?: () => void;
  onUpdate?: (event: PanEvent) => void;
  onFinalize?: (event: PanEvent, success: boolean) => void;
};
const pans = vi.hoisted(() => [] as Handlers[]);
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => children,
  Gesture: {
    Pan: () => {
      const handlers: Handlers = {};
      pans.push(handlers);
      const pan = {
        minDistance: () => pan,
        shouldCancelWhenOutside: () => pan,
        runOnJS: () => pan,
        onStart: (callback: Handlers["onStart"]) => ((handlers.onStart = callback), pan),
        onUpdate: (callback: Handlers["onUpdate"]) => ((handlers.onUpdate = callback), pan),
        onFinalize: (callback: Handlers["onFinalize"]) => ((handlers.onFinalize = callback), pan),
      };
      return pan;
    },
  },
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
import { SettingsDragHandle } from "./SettingsDragHandle";

it("uses the release position even when it differs from the last update", () => {
  pans.length = 0;
  const onEnd = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    act(() =>
      root.render(
        <SettingsDragHandle
          title="Microphone"
          canMoveUp
          canMoveDown
          onStart={() => {}}
          onMove={() => {}}
          onEnd={onEnd}
          onStep={() => {}}
        />,
      ),
    );
    const pan = pans.at(-1)!;
    act(() => {
      pan.onStart?.();
      pan.onUpdate?.({ translationY: 64 });
      pan.onFinalize?.({ translationY: 130 }, true);
    });
    expect(onEnd).toHaveBeenCalledWith(130, false);
  } finally {
    act(() => root.unmount());
  }
});

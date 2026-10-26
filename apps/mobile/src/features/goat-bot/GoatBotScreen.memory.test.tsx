import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  nativeSpace,
  nativeId,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark" }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useKeyboardState: () => false,
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollViewMarker: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("react-native-svg", () => ({ default: () => null, Path: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: 16 },
  }),
}));
import { GoatBotTimelineRow } from "./GoatBotScreen";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
  appearance.mode = "light";
});
it("opens a report's exact memory target and leaves legacy text without an action", async () => {
  h = createNativeMemoryHarness();
  await h.waitForAtom(h.memory.syncStatus.permissionAtom(nativeEnv), Boolean);
  const row = {
    id: "row",
    kind: "assistant",
    text: "Synthetic resolution report",
    options: [],
    tone: "reply",
    firstInGroup: true,
    memory: { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
  } as unknown as GoatBotRow;
  const props = {
    canSend: false,
    onSend: () => false,
    onRetry: () => {},
    onSelectThread: () => {},
  };
  view = renderNative(h, <GoatBotTimelineRow {...props} row={row} />);
  await view.render();
  await view.click("View memory details");
  expect(h.navigations).toMatchObject([
    [
      "SettingsMemory",
      { environmentId: nativeEnv, memorySpaceId: nativeSpace, memoryId: nativeId },
    ],
  ]);
  await act(async () => h.revoke());
  expect(view.container.textContent).toContain("Memory read permission is required");
  await act(async () => {
    const current = h.registry.get(h.configs(nativeEnv))!;
    h.registry.set(h.configs(nativeEnv), {
      ...current,
      environment: {
        ...current.environment,
        capabilities: { ...current.environment.capabilities, memory: undefined },
      },
    });
  });
  expect(view.container.textContent).toContain("Synthetic resolution report");
  expect(view.container.querySelector("button")).toBeNull();
  await view.rerender(
    <GoatBotTimelineRow {...props} row={{ ...row, memory: undefined } as GoatBotRow} />,
  );
  expect(view.container.textContent).toContain("Synthetic resolution report");
  expect(view.container.querySelector("button")).toBeNull();
});

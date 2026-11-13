import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
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
// Event lines resolve their routine or task against the home's reads, which this test does not load.
// Chat file cards read the Library through the environment runtime; GoatBotTimelineRow.files.test covers them.
// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("./GoatBotReplyFiles", () => ({
  GoatBotFilesProvider: (props: { children?: unknown }) => props.children,
  GoatBotReplyFiles: () => null,
}));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
vi.mock("./GoatBotFace", () => ({
  GoatBotHeaderFace: () => null,
  GoatBotProgressFace: () => null,
}));
vi.mock("./GoatBotShimmerText", () => ({ GoatBotShimmerText: () => null }));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
// The native Markdown renderer cannot load under Vitest.
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
// The chat's step reader and file opener load the environment runtime.
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("./openBotLibraryFile", () => ({ openBotLibraryFile: async () => null }));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: async () => true }));
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

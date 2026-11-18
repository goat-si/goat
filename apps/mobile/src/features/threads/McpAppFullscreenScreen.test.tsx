import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ goBack: () => {}, isFocused: () => true, addListener: () => () => {} }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { turnItem: () => ({}) },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => undefined,
  useThreadShells: () => [],
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: undefined }) }));
vi.mock("./McpAppWebView", () => ({ ThreadMcpApp: () => null }));

import { McpAppFullscreenScreen } from "./McpAppFullscreenScreen";

it.each([
  { environmentId: "", threadId: "thread-1", itemId: "item-1" },
  { environmentId: "env-1", threadId: " ", itemId: "item-1" },
  { environmentId: "env-1", threadId: "thread-1", itemId: "" },
])("shows that a link with a blank ID cannot be shown instead of crashing", (params) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<McpAppFullscreenScreen route={{ params }} />));
    expect(container.textContent).toContain("This app cannot be shown.");
  } finally {
    act(() => root.unmount());
  }
});

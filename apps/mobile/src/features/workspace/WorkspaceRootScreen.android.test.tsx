import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

const mocks = vi.hoisted(() => ({
  state: undefined as WorkspaceTabsState | undefined,
  selected: [] as string[],
  backListeners: new Set<() => boolean>(),
}));

vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      mocks.backListeners.add(listener);
      return { remove: () => mocks.backListeners.delete(listener) };
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");
  return {
    SafeAreaInsetsContext: createContext({ top: 0, right: 0, bottom: 0, left: 0 }),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false }, startNewTask: () => {} }),
}));
vi.mock("./useSelectWorkspaceTab", () => ({
  useSelectWorkspaceTab: () => (tab: string) => mocks.selected.push(tab),
}));
vi.mock("./WorkspaceTabsContext", async () => {
  const { createContext } = await import("react");
  return {
    WorkspaceTabsContext: createContext(null),
    useWorkspaceTabs: () => ({ state: mocks.state, dispatch: () => undefined }),
  };
});
vi.mock("./navigation-tabs", () => ({
  useEnabledNavigationTabs: () => ["threads", "pullRequests", "usage"],
}));
vi.mock("./WorkspaceNoTabs", () => ({ WorkspaceNoTabs: () => null }));
vi.mock("./WorkspaceExtraTab", () => ({ WorkspaceExtraTab: () => null }));
vi.mock("./WorkspaceTabPanes", () => ({ WorkspaceTabPanes: () => null }));
vi.mock("./AndroidWorkspaceNavigation", () => ({ AndroidWorkspaceNavigation: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ fabClearance: 64 }),
}));
vi.mock("../home/HomeRouteScreen", () => ({ HomeRouteScreen: () => null }));
vi.mock("../goat-bot/useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ mode: "thread" }),
}));
vi.mock("../pull-requests/PullRequestFilterMenuContext", () => ({
  PullRequestFilterMenuProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../pull-requests/PullRequestsScreen", () => ({ PullRequestsScreen: () => null }));
vi.mock("../pull-requests/PullRequestToolbar.android", () => ({ PullRequestToolbar: () => null }));

import { WorkspaceRootScreen } from "./WorkspaceRootScreen.android";

function selected(tab: WorkspaceTab, search = false) {
  const state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "select", tab });
  return search ? workspaceTabsReducer(state, { type: "search", tab: "pullRequests" }) : state;
}

/** Android calls the newest listener first and stops at the first that handles Back. */
function pressBack() {
  return [...mocks.backListeners].reverse().some((listener) => listener());
}

async function renderRoot(state: WorkspaceTabsState) {
  mocks.state = state;
  mocks.selected = [];
  mocks.backListeners.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(WorkspaceRootScreen)));
  return { [Symbol.dispose]: () => act(() => root.unmount()) };
}

it.each(["pullRequests", "usage"] as const)(
  "Back from the %s tab returns to Threads instead of leaving the app",
  async (tab) => {
    using _root = await renderRoot(selected(tab));
    expect(pressBack()).toBe(true);
    expect(mocks.selected).toEqual(["threads"]);
  },
);

it("leaves Back to Threads itself and to an open search", async () => {
  {
    using _root = await renderRoot(selected("threads"));
    expect(pressBack()).toBe(false);
  }
  using _root = await renderRoot(selected("pullRequests", true));
  expect(pressBack()).toBe(false);
  expect(mocks.selected).toEqual([]);
});

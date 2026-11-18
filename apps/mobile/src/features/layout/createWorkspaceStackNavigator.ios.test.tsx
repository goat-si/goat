import { act, createContext, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { NativeStackView } from "@react-navigation/native-stack";
import type { Split, Tabs } from "react-native-screens";
import { expect, it, vi } from "vite-plus/test";
import type { NavigationTab } from "../workspace/navigation-tab-order";
import { NativeWorkspaceInspectorContext } from "../../native/v5-workspace-context";

type SplitHostProps = ComponentProps<typeof Split.Host>;
type TabsHostProps = ComponentProps<typeof Tabs.Host>;
type ViewProps = ComponentProps<typeof NativeStackView>;

const harness = vi.hoisted(() => {
  vi.stubGlobal("require", () => 1);
  return {
    passthrough: ({ children }: { readonly children?: ReactNode }) => children,
    disabled: [] as NavigationTab[],
    tabsHost: null as TabsHostProps | null,
    dismissInspector: vi.fn(),
    selectTab: vi.fn(),
  };
});

const home = { name: "Home", key: "home" };
const state = {
  key: "root",
  routes: [home],
  index: 0,
  routeNames: ["Home"],
  preloadedRoutes: [],
  type: "stack",
  stale: false,
};
const navigation = { getState: () => state, dispatch: vi.fn(), emit: vi.fn() };
const homeDescriptor = { route: home, navigation, options: {}, render: () => <span>Home</span> };
const descriptors = { home: homeDescriptor };
const tabs = ["threads", "pullRequests", "usage"] as const;

vi.mock("@react-navigation/native", () => ({
  createNavigatorFactory: (Navigator: unknown) => () => ({ Navigator }),
  NavigationContext: createContext(undefined),
  NavigationRouteContext: createContext(undefined),
  StackRouter: () => null,
  useNavigationBuilder: () => ({
    state,
    navigation,
    descriptors,
    describe: () => homeDescriptor,
    NavigationContent: harness.passthrough,
  }),
}));
vi.mock("@react-navigation/native-stack", () => ({
  NativeStackView: ({ state, descriptors }: ViewProps) =>
    descriptors[state.routes[state.index]!.key]?.render(),
}));
vi.mock("react-native", () => ({
  Keyboard: { dismiss: () => {} },
  StyleSheet: { absoluteFill: {} },
  View: harness.passthrough,
  useWindowDimensions: () => ({ width: 1200 }),
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: harness.passthrough }));
vi.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: harness.passthrough }));
vi.mock("react-native-screens", () => ({
  Tabs: {
    Host: (props: TabsHostProps) => {
      harness.tabsHost = props;
      return props.children;
    },
    Screen: ({
      children,
      screenKey,
      preventNativeSelection,
    }: ComponentProps<typeof Tabs.Screen>) => (
      <article data-slot={screenKey} data-prevent-selection={preventNativeSelection || undefined}>
        {children}
      </article>
    ),
  },
  Split: {
    Host: ({ children, showInspector, onInspectorHide }: SplitHostProps) => (
      <section data-inspector-visible={showInspector || undefined}>
        {children}
        {onInspectorHide && (
          <button onClick={() => onInspectorHide({ nativeEvent: {} } as never)}>
            Dismiss inspector
          </button>
        )}
      </section>
    ),
    Column: harness.passthrough,
    Stack: harness.passthrough,
    Screen: harness.passthrough,
    Inspector: harness.passthrough,
    HeaderConfig: () => null,
  },
}));
vi.mock("./AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: true, listPaneWidth: 300 },
    panes: { primarySidebarVisible: true },
    toggleAuxiliaryPane: harness.dismissInspector,
    openWorkspaceTab: harness.selectTab,
  }),
}));
vi.mock("./workspace-pane-divider", () => ({ WorkspacePaneDivider: () => null }));
vi.mock("./WorkspaceEmptyDetail", () => ({ WorkspaceEmptyDetail: () => null }));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsReady: () => true,
  useNativeWorkspaceColumnsSupported: () => true,
}));
vi.mock("../../native/native-layout-metrics", () => ({
  useDeviceType: () => "duo-unfolded",
  useNativeLayoutMetrics: () => null,
}));
vi.mock("../../native/NativeColumnContent.ios", () => ({
  NativeColumnContent: harness.passthrough,
}));
vi.mock("../../native/V5StackHeader.ios", () => ({ V5StackHeader: () => null }));
vi.mock("../../native/createV5StackNavigator.ios", () => ({
  V5CardStackView: () => null,
  V5StackView: () => null,
  modalEnvelopeOptions: () => ({}),
}));
vi.mock("../../components/ui/useControlTheme", () => ({
  useControlTheme: () => ({ colors: {} }),
}));
vi.mock("../workspace/WorkspaceSidebarTabs", () => ({ WorkspaceSidebarTabs: () => null }));
vi.mock("../workspace/useSystemWorkspaceTabBar", () => ({
  useCompactWorkspaceTabs: () => false,
  useSystemWorkspaceTabBar: () => true,
}));
vi.mock("../workspace/navigation-tabs", () => ({
  WORKSPACE_TAB_LABELS: { threads: "Threads", pullRequests: "Pulls", usage: "Usage" },
  NAVIGATION_TAB_ICONS: {},
  useNavigationTabOrder: () => tabs,
  useHiddenNavigationTabs: () => harness.disabled,
  useEnabledNavigationTabs: () => tabs.filter((tab) => !harness.disabled.includes(tab)),
}));
vi.mock("../workspace/workspace-detail-selection", () => ({
  setNativelyPoppingWorkspaceRoute: () => {},
}));
vi.mock("../workspace/workspace-selection-store", () => ({
  currentWorkspaceSelections: () => ({}),
  workspaceSelectionCheck: { thread: () => true, pullRequest: () => true },
}));
vi.mock("../../state/use-thread-pr", () => ({ withKnownPullRequestSummary: () => ({}) }));

import { createWorkspaceStackNavigator } from "./createWorkspaceStackNavigator.ios";

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.disabled = [];
  harness.dismissInspector.mockClear();
  harness.selectTab.mockClear();
  const frameJobs = new Map<number, FrameRequestCallback>();
  const idleJobs = new Map<number, IdleRequestCallback>();
  let nextJob = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameJobs.set(++nextJob, callback);
    return nextJob;
  });
  vi.stubGlobal("cancelAnimationFrame", (job: number) => frameJobs.delete(job));
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleJobs.set(++nextJob, callback);
    return nextJob;
  });
  vi.stubGlobal("cancelIdleCallback", (job: number) => idleJobs.delete(job));

  const { Navigator } = createWorkspaceStackNavigator();
  const container = document.createElement("div");
  const root = createRoot(container);
  const inspector = {
    render: () => <span>Active thread inspector</span>,
    visible: true,
    widthFraction: 0.4,
    setWidthFraction: () => {},
  };

  const render = () =>
    act(() =>
      root.render(
        <NativeWorkspaceInspectorContext value={inspector}>
          <Navigator>
            <></>
          </Navigator>
        </NativeWorkspaceInspectorContext>,
      ),
    );
  return {
    render,
    slot: (key: string) => container.querySelector(`[data-slot="${key}"]`),
    commitNativeFrame() {
      const pending = [...frameJobs.values()];
      frameJobs.clear();
      act(() => pending.forEach((callback) => callback(0)));
    },
    prewarmDuringIdle() {
      const pending = [...idleJobs.values()];
      idleJobs.clear();
      act(() =>
        pending.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 5 })),
      );
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("keeps one live inspector when the other workspace tabs prewarm", () => {
  using screen = setup();
  screen.render();
  screen.commitNativeFrame();
  screen.prewarmDuringIdle();

  expect(screen.slot("first")?.textContent).toContain("Active thread inspector");
  for (const hidden of ["second", "settings"]) {
    const slot = screen.slot(hidden);
    expect(slot?.querySelector("section")).not.toBeNull();
    expect(slot?.textContent).not.toContain("Active thread inspector");
    expect(slot?.querySelector("[data-inspector-visible]")).toBeNull();
    expect(slot?.querySelector("button")).toBeNull();
  }
  act(() => screen.slot("first")?.querySelector("button")?.click());
  expect(harness.dismissInspector).toHaveBeenCalledOnce();
});

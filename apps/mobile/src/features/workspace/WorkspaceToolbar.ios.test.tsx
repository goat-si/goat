import { act, createRef, useImperativeHandle, useReducer, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  type WorkspaceSearchTab,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

const mocks = vi.hoisted(() => ({
  screenFocused: true,
  options: null as null | { headerSearchBarOptions?: Record<string, never> },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
  useNavigation: () => ({ isFocused: () => mocks.screenFocused }),
}));
vi.mock("../../state/active-new-task", () => ({ useActiveNewTask: () => null }));
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(() => null, {
    Button: () => null,
    Spacer: () => null,
    SearchBarSlot: () => null,
  }),
}));
vi.mock("../../lib/device-type", () => ({
  isDuoDevice: (type: string) => type.startsWith("duo"),
}));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: true }));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: (props: { options: typeof mocks.options }) => {
    mocks.options = props.options;
    return null;
  },
}));
vi.mock("../../native/v5-workspace-context", async () => {
  const { createContext } = await import("react");
  return {
    NativePrimaryColumnContext: createContext(null),
    NativeWorkspaceTabActivityContext: createContext(null),
  };
});
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: () => {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    panes: { primarySidebarVisible: true },
    togglePrimarySidebar: () => {},
  }),
}));
vi.mock("./WorkspaceTabsContext", async () => {
  const { createContext, use } = await import("react");
  const TestWorkspace = createContext<unknown>(null);
  return { TestWorkspace, useWorkspaceTabs: () => use(TestWorkspace) };
});
vi.mock("./useSystemWorkspaceTabBar", () => ({
  useCompactWorkspaceTabs: () => false,
  useSidebarWorkspaceTabs: () => "none",
}));
vi.mock("./WorkspaceSectionToolbar", () => ({ WorkspaceTabToolbarButtons: () => null }));

const { WorkspaceToolbar } = await import("./WorkspaceToolbar.ios");
const { TestWorkspace } = (await import("./WorkspaceTabsContext")) as unknown as {
  TestWorkspace: import("react").Context<unknown>;
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness(props: {
  readonly tab: WorkspaceSearchTab;
  readonly query: string;
  readonly stateRef: Ref<WorkspaceTabsState>;
}) {
  const [state, dispatch] = useReducer(workspaceTabsReducer, null, () => {
    let next = workspaceTabsReducer(initialWorkspaceTabsState(), {
      type: "search",
      tab: props.tab,
    });
    next = workspaceTabsReducer(next, { type: "query", tab: props.tab, query: props.query });
    return next;
  });
  useImperativeHandle(props.stateRef, () => state, [state]);
  return (
    <TestWorkspace
      value={{
        state,
        dispatch,
        settingsOpen: props.tab === "settings",
        isTabActive: () => true,
        getScrollOffset: () => 0,
        recordScrollOffset: () => {},
        bottomClearance: 0,
      }}
    >
      <WorkspaceToolbar onNewTask={() => {}} />
    </TestWorkspace>
  );
}

function renderSearch(tab: WorkspaceSearchTab, query: string) {
  mocks.screenFocused = true;
  const root = createRoot(document.createElement("div"));
  const stateRef = createRef<WorkspaceTabsState>();
  act(() => root.render(<Harness tab={tab} query={query} stateRef={stateRef} />));
  const state = () => stateRef.current!;
  const native = {
    setText: vi.fn(),
    clearText: vi.fn(),
    blur: vi.fn(),
    focus: vi.fn(),
    setActive: vi.fn(),
    cancelSearch: vi.fn(),
  };
  const search = () =>
    mocks.options?.headerSearchBarOptions as unknown as {
      ref: { current: unknown };
      onBlur: () => void;
      onFocus: () => void;
      onSearchButtonPress: () => void;
    };
  search().ref.current = native;
  return { root, native, search, state };
}

it("closing a phone's Settings search with its X clears the query that kept filtering", () => {
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
  const { root, native, search, state } = renderSearch("settings", "zzz");
  act(() => search().onBlur());
  expect(state().tabs.settings).toMatchObject({ query: "", searchMode: "resting" });
  expect(native.clearText).toHaveBeenCalled();
  act(() => root.unmount());
});

it("keeps the Settings query when the Search key or a pushed page ends editing", () => {
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
  const searchKey = renderSearch("settings", "theme");
  act(() => searchKey.search().onSearchButtonPress());
  act(() => searchKey.search().onBlur());
  expect(searchKey.state().tabs.settings).toMatchObject({ query: "theme", searchMode: "expanded" });
  act(() => searchKey.root.unmount());

  const pushed = renderSearch("settings", "theme");
  mocks.screenFocused = false;
  act(() => pushed.search().onBlur());
  expect(pushed.state().tabs.settings).toMatchObject({ query: "theme", searchMode: "expanded" });
  act(() => pushed.root.unmount());
});

it("reopening a list search after a blur shows the query that still filters the list", () => {
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
  const { root, native, search, state } = renderSearch("threads", "diff");
  act(() => search().onBlur());
  expect(state().tabs.threads).toMatchObject({ query: "diff", searchMode: "expanded" });
  act(() => search().onFocus());
  expect(native.setText).toHaveBeenCalledWith("diff");
  expect(state().tabs.threads.searchMode).toBe("active");
  act(() => root.unmount());
});

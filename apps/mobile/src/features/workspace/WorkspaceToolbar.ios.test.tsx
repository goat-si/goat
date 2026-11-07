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
const { NativePrimaryColumnContext } =
  (await import("../../native/v5-workspace-context")) as unknown as {
    NativePrimaryColumnContext: import("react").Context<unknown>;
  };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness(props: {
  readonly tab: WorkspaceSearchTab;
  readonly query: string;
  readonly sidebar: boolean;
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
      <NativePrimaryColumnContext value={props.sidebar ? { presented: true } : null}>
        <WorkspaceToolbar onNewTask={() => {}} sidebar={props.sidebar} />
      </NativePrimaryColumnContext>
    </TestWorkspace>
  );
}

function renderSearch(tab: WorkspaceSearchTab, query: string, sidebar = false) {
  mocks.screenFocused = true;
  const root = createRoot(document.createElement("div"));
  const stateRef = createRef<WorkspaceTabsState>();
  act(() => root.render(<Harness tab={tab} query={query} sidebar={sidebar} stateRef={stateRef} />));
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
      onClose?: () => void;
      onFocus: () => void;
      onSearchButtonPress: () => void;
    };
  search().ref.current = native;
  return { root, native, search, state };
}

it.each(["settings", "threads"] as const)(
  "closing %s search with its X clears the query that kept filtering, with or without the keyboard",
  (tab) => {
    using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
    const typing = renderSearch(tab, "zzz");
    act(() => typing.search().onClose?.());
    expect(typing.state().tabs[tab]).toMatchObject({ query: "", searchMode: "resting" });
    expect(typing.native.clearText).toHaveBeenCalled();
    act(() => typing.root.unmount());

    const keyboardDown = renderSearch(tab, "zzz");
    act(() => keyboardDown.search().onBlur());
    act(() => keyboardDown.search().onClose?.());
    expect(keyboardDown.state().tabs[tab]).toMatchObject({ query: "", searchMode: "resting" });
    act(() => keyboardDown.root.unmount());
  },
);

it("keeps the Settings query when the Search key ends editing or a pushed page closes search", () => {
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
  const searchKey = renderSearch("settings", "theme");
  act(() => searchKey.search().onSearchButtonPress());
  act(() => searchKey.search().onBlur());
  expect(searchKey.state().tabs.settings).toMatchObject({ query: "theme", searchMode: "expanded" });
  act(() => searchKey.root.unmount());

  const pushed = renderSearch("settings", "theme");
  mocks.screenFocused = false;
  act(() => pushed.search().onBlur());
  act(() => pushed.search().onClose?.());
  expect(pushed.state().tabs.settings).toMatchObject({ query: "theme", searchMode: "expanded" });
  act(() => pushed.root.unmount());
});

it("closing a split view sidebar's search clears it while the detail column owns navigation focus", () => {
  using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
  const { root, native, search, state } = renderSearch("threads", "diff", true);
  mocks.screenFocused = false;
  act(() => search().onClose?.());
  expect(state().tabs.threads).toMatchObject({ query: "", searchMode: "resting" });
  expect(native.clearText).toHaveBeenCalled();
  act(() => root.unmount());
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

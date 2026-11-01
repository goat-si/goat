import { act } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";
const history = vi.hoisted(() => ({ allowed: true, select: vi.fn() }));
vi.mock("./useThreadHistoryMenu", () => ({
  useThreadHistoryMenu: () => ({
    actions: history.allowed ? [{ id: "input-history", title: "Computer use history" }] : [],
    select: history.select,
    dialog: null,
  }),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: {},
    toggleAuxiliaryPane: () => {},
    togglePrimarySidebar: () => {},
  }),
}));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => () => {},
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("./ThreadGitControls", () => ({
  ThreadGitControls: () => null,
  useThreadGitCenterHeaderItems: () => [],
  useThreadGitRightHeaderItems: () => [],
}));
vi.mock("../../components/ui/ScreenHeaderButton", () => ({ ScreenHeaderButton: () => null }));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: {
    options: {
      unstable_headerRightItems?: () => Array<{ identifier: string; onPress: () => void }>;
    };
    actions: Array<{ accessibilityLabel: string; onPress: () => void }>;
    menus?: Array<{ title: string; items: Array<{ title: string; onPress: () => void }> }>;
  }) => (
    <div>
      {props.options.unstable_headerRightItems?.().map((item) => (
        <button key={item.identifier} onClick={item.onPress}>
          iOS {item.identifier}
        </button>
      ))}
      {props.menus?.flatMap((menu) =>
        menu.items.map((item) => (
          <button key={item.title} onClick={item.onPress}>
            {item.title}
          </button>
        )),
      )}
      {props.actions.map((action) => (
        <button key={action.accessibilityLabel} onClick={action.onPress}>
          Android {action.accessibilityLabel}
        </button>
      ))}
    </div>
  ),
}));
import { ThreadHeader } from "./ThreadHeader";
let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});
it("keeps memory management out of persistent headers on both platforms", async () => {
  h = createNativeMemoryHarness();
  const props = {
    title: "Synthetic thread",
    subtitle: "",
    headerColor: "#000",
    usesNativeHeaderGlass: true,
    gitControls: {
      environmentId: nativeEnv,
      threadId: "synthetic-thread",
      projectScripts: [],
      terminalSessions: [],
    },
    hasThreadCwd: false,
    hasWorkspaceRoot: false,
    fileInspectorSupported: false,
    inspectorMode: null,
    onToggleInspector: () => {},
    onOpenGitInspector: () => {},
    onOpenFilesInspector: () => {},
  } as unknown as Parameters<typeof ThreadHeader>[0];
  view = renderNative(h, <ThreadHeader {...props} />);
  await view.render();
  expect(view.container.textContent).not.toContain("memory");
  expect(view.container.textContent).toContain("Computer use history");
  await view.click("Computer use history");
  expect(history.select).toHaveBeenCalledWith("input-history");
  history.allowed = false;
  await view.rerender(<ThreadHeader {...props} />);
  expect(view.container.textContent).not.toContain("Computer use history");
  history.allowed = true;
  expect(h.navigations).toHaveLength(0);
  await act(async () => h.registry.set(h.configs(nativeEnv), null));
  await view.rerender(<ThreadHeader {...props} />);
  expect(view.container.textContent).not.toContain("memory");
});

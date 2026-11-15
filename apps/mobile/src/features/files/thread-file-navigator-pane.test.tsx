import { EnvironmentId } from "@goat/contracts";
import { act, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const queries = vi.hoisted(() => [] as { cwd: string | null; searchQuery: string }[]);

// Babel inlines Platform.OS for iOS here, so the pane renders its native search bar.
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26.0" },
  Pressable: ({ children }: { children?: ReactNode }) => children,
  View: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("react-native-screens", async () => {
  const { useImperativeHandle, useRef } = await import("react");
  const Children = ({ children }: { children?: ReactNode }) => children;
  return {
    Screen: Children,
    ScreenStack: Children,
    ScreenStackHeaderConfig: Children,
    ScreenStackHeaderSearchBarView: Children,
    // Uncontrolled like the native bar: only setText changes what it shows.
    SearchBar: (props: {
      ref?: Ref<{ setText: (text: string) => void }>;
      onChangeText: (event: { nativeEvent: { text: string } }) => void;
    }) => {
      const input = useRef<HTMLInputElement>(null);
      useImperativeHandle(props.ref, () => ({
        setText: (text: string) => {
          if (input.current) input.current.value = text;
        },
      }));
      return (
        <input
          ref={input}
          onChange={(event) => props.onChangeText({ nativeEvent: { text: event.target.value } })}
        />
      );
    },
  };
});
vi.mock("@goat/client-runtime/state/filesystem", () => ({
  resolveFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("../../state/session", () => ({ environmentSession: { sessionStateAtom: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../native/StackHeader", () => ({ nativeHeaderScrollEdgeEffects: () => undefined }));
vi.mock("../../native/NativeInspectorContent", () => ({
  NativeInspectorContent: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ toggleAuxiliaryPane: () => {} }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null, AppTextInput: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./FilesHeader", () => ({ FilesHeader: () => null }));
vi.mock("./preload-workspace-file", () => ({ preloadWorkspaceFileContents: () => {} }));
vi.mock("./FileTreeBrowser", () => ({ FileTreeBrowser: () => null }));
vi.mock("./useFileTreeEntries", () => ({
  useFileTreeEntries: (input: { cwd: string | null; searchQuery: string }) => {
    queries.push({ cwd: input.cwd, searchQuery: input.searchQuery });
    return { refresh: () => {}, selectPath: () => {} };
  },
}));

import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";

it("starts unfiltered when the mounted pane switches to another workspace", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = (cwd: string) =>
    act(() =>
      root.render(
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={EnvironmentId.make("env")}
          headerInset={0}
          projectName="Files"
          selectedPath={null}
          onSelectFile={() => {}}
        />,
      ),
    );
  try {
    render("/first");
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "alpha",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(queries.at(-1)).toEqual({ cwd: "/first", searchQuery: "alpha" });

    render("/second");
    expect(queries.at(-1)).toEqual({ cwd: "/second", searchQuery: "" });
    expect(container.querySelector("input")!.value).toBe("");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

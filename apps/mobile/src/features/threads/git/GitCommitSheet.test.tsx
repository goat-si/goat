import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  value: string;
  onChangeText: (value: string) => void;
};
type ButtonProps = { label: string; disabled?: boolean; onPress: () => void };
type PressProps = {
  accessibilityLabel?: string;
  accessibilityState?: { checked?: boolean };
  onPress: () => void;
};
const state = vi.hoisted(() => ({
  files: [{ path: "src/a.ts", insertions: 1, deletions: 0 }] as Array<{
    path: string;
    insertions: number;
    deletions: number;
  }>,
  inputs: new Map<string, InputProps>(),
  buttons: new Map<string, ButtonProps>(),
  pressables: new Map<string, PressProps>(),
  goBack: vi.fn(),
  focused: true,
  commits: [] as Array<{
    action?: string;
    featureBranch?: boolean;
    commitMessage?: string;
    filePaths?: ReadonlyArray<string>;
  }>,
  finishCommit: null as ((result: object | null) => void) | null,
  failureRenders: 0,
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: state.goBack, isFocused: () => state.focused }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ height: 800 }),
  View: ({ children }: { children: ReactNode }) => children,
  ScrollView: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: PressProps) => {
    if (props.accessibilityLabel) state.pressables.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: ButtonProps) => {
    state.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => children,
  AppTextInput: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      refName: "feature",
      isDefaultRef: false,
      workingTree: { files: [...state.files] },
    },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment" } }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canChangeThreadBranch: true,
    onRunSelectedThreadGitAction: (input: { commitMessage?: string }) => {
      state.commits.push(input);
      return new Promise<object | null>((resolve) => {
        state.finishCommit = resolve;
      });
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("./gitSheetComponents", () => ({
  GitActionFailure: () => {
    state.failureRenders += 1;
    return null;
  },
}));

const { GitCommitSheet } = await import("./GitCommitSheet");

async function commitTyped(message: string) {
  state.failureRenders = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.goBack.mockClear();
  state.commits = [];
  state.focused = true;
  const root = createRoot(document.createElement("div"));
  const props = {} as Parameters<typeof GitCommitSheet>[0];
  await act(async () => root.render(<GitCommitSheet {...props} />));
  await act(async () => state.inputs.get("Commit message")!.onChangeText(message));
  await act(async () => state.buttons.get("Commit changes")!.onPress());
  return root;
}

it("keeps the sheet and the typed commit message when the commit fails", async () => {
  const root = await commitTyped("fix: keep what I typed");
  expect(state.commits).toEqual([
    expect.objectContaining({ commitMessage: "fix: keep what I typed" }),
  ]);
  expect(state.goBack, "the sheet stays open while the commit runs").not.toHaveBeenCalled();

  await act(async () => state.finishCommit!(null));
  expect(state.goBack).not.toHaveBeenCalled();
  // The open sheet still holds the place where a failed action reports itself (goat#3654).
  expect(state.failureRenders).toBeGreaterThan(0);
  expect(state.inputs.get("Commit message")!.value).toBe("fix: keep what I typed");
  act(() => root.unmount());
});

it("closes the sheet once the commit succeeds", async () => {
  const root = await commitTyped("fix: done");
  await act(async () => state.finishCommit!({ commit: { status: "created" } }));
  expect(state.goBack).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it("leaves navigation alone when the person left the sheet before the commit finished", async () => {
  const root = await commitTyped("fix: done");
  state.focused = false;
  await act(async () => state.finishCommit!({ commit: { status: "created" } }));
  expect(state.goBack).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it("treats remaining files as all selected when an excluded file disappears", async () => {
  const initialFiles = state.files;
  const twoFiles = [
    { path: "include.ts", insertions: 1, deletions: 0 },
    { path: "later.ts", insertions: 1, deletions: 0 },
  ];
  state.files = twoFiles;
  state.commits = [];
  state.goBack.mockClear();
  state.focused = true;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const props = {} as Parameters<typeof GitCommitSheet>[0];
  const render = () => {
    state.buttons.clear();
    state.pressables.clear();
    act(() => root.render(<GitCommitSheet {...props} />));
  };
  const toggleAllButton = () =>
    state.buttons.get("Select all") ?? state.buttons.get("Deselect all");
  try {
    render();
    act(() => state.pressables.get("later.ts")!.onPress());
    state.files = twoFiles.slice(0, 1);
    render();

    expect(toggleAllButton()?.label).toBe("Deselect all");
    act(() => toggleAllButton()!.onPress());
    state.files = twoFiles;
    render();
    expect(state.pressables.get("later.ts")!.accessibilityState?.checked).toBe(false);
    expect(state.pressables.get("include.ts")!.accessibilityState?.checked).toBe(false);

    act(() => state.pressables.get("include.ts")!.onPress());
    state.files = twoFiles.slice(0, 1);
    render();
    act(() => state.buttons.get("Commit changes")!.onPress());
    await act(async () => state.finishCommit!({ commit: { status: "created" } }));
    expect(state.commits).toEqual([
      { action: "commit", featureBranch: false, filePaths: ["include.ts"] },
    ]);
  } finally {
    act(() => root.unmount());
    state.files = initialFiles;
  }
});

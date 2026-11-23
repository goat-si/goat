import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  value: string;
  onChangeText: (value: string) => void;
};
type ActionProps = { label: string; disabled: boolean; onPress: () => void };
const state = vi.hoisted(() => ({
  refName: null as string | null,
  branch: null as string | null,
  inputs: new Map<string, InputProps>(),
  actions: new Map<string, ActionProps>(),
  worktrees: [] as Array<{ baseBranch: string; newBranch: string }>,
  focused: true,
  goBackCalls: 0,
  gitResult: Promise.resolve<object | null>(null),
  checkout: null as null | (() => void),
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => state.goBackCalls++, isFocused: () => state.focused }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ height: 800 }),
  View: ({ children }: { children: ReactNode }) => children,
  ScrollView: ({ children }: { children: ReactNode }) => children,
  Pressable: (props: { onPress: () => void }) => {
    state.checkout = props.onPress;
    return null;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => children,
  AppTextInput: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.refName === null ? undefined : { refName: state.refName },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment", branch: state.branch },
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: [{ name: "release/stable", worktreePath: null }],
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: true,
    onCreateSelectedThreadBranch: () => state.gitResult,
    onCheckoutSelectedThreadBranch: () => state.gitResult,
    onCreateSelectedThreadWorktree: (input: { baseBranch: string; newBranch: string }) => {
      state.worktrees.push(input);
      return state.gitResult;
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { branch: () => null } }));
vi.mock("./gitSheetComponents", () => ({
  GitActionFailure: () => null,
  SheetActionButton: (props: ActionProps) => {
    state.actions.set(props.label, props);
    return null;
  },
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

function setup(branch: string | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refName = null;
  state.branch = branch;
  state.inputs.clear();
  state.actions.clear();
  state.worktrees = [];
  state.focused = true;
  state.goBackCalls = 0;
  state.gitResult = Promise.resolve(null);
  state.checkout = null;
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() => {
      root.render(
        <GitBranchesSheet
          route={{ params: { environmentId: "environment", threadId: "thread" } }}
        />,
      );
    });
  render();
  return {
    render,
    edit(label: string, value: string) {
      act(() => state.inputs.get(label)!.onChangeText(value));
    },
    create() {
      act(() => state.actions.get("Create worktree")!.onPress());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it.each([null, "stale-branch"])(
  "uses the loaded checkout branch when thread metadata is %s",
  (branch) => {
    using screen = setup(branch);
    screen.edit("Worktree branch name", "feature/new-worktree");
    state.refName = "release/stable";
    screen.render();
    screen.create();
    expect(state.worktrees).toEqual([
      { baseBranch: "release/stable", newBranch: "feature/new-worktree" },
    ]);
  },
);

it.each(["custom-base", ""])("preserves an edited base %j when status arrives", (base) => {
  using screen = setup();
  screen.edit("Worktree base branch", base);
  screen.edit("Worktree branch name", "feature/new-worktree");
  state.refName = "release/stable";
  screen.render();
  expect(state.inputs.get("Worktree base branch")!.value).toBe(base);
  expect(state.actions.get("Create worktree")!.disabled).toBe(base === "");
  screen.create();
  expect(state.worktrees).toEqual(
    base === "" ? [] : [{ baseBranch: base, newBranch: "feature/new-worktree" }],
  );
});

it.each(["Create worktree", "Create & checkout", "checkout"])(
  "does not navigate back after %s finishes out of focus",
  async (action) => {
    using screen = setup();
    const result = Promise.withResolvers<object>();
    state.gitResult = result.promise;
    screen.edit("New branch name", "feature/new-branch");
    screen.edit("Worktree branch name", "feature/new-worktree");
    act(() => {
      if (action === "checkout") state.checkout?.();
      else state.actions.get(action)?.onPress();
    });
    state.focused = false;
    await act(async () => {
      result.resolve({ refName: "feature/ready" });
      await result.promise;
    });
    expect(state.goBackCalls).toBe(0);
  },
);

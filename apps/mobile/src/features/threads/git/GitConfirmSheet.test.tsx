import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ActionProps = { label: string; disabled?: boolean; onPress: () => void };
const state = vi.hoisted(() => ({
  refName: null as string | null,
  actions: [] as ActionProps[],
  ran: [] as object[],
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ScrollView: ({ children }: { children: ReactNode }) => children,
  useWindowDimensions: () => ({ height: 800 }),
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {} }),
}));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.refName === null ? undefined : { refName: state.refName },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment" },
    selectedThreadProject: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canChangeThreadBranch: true,
    onRunSelectedThreadGitAction: (input: object) => {
      state.ran.push(input);
      return Promise.resolve(null);
    },
    refreshSelectedThreadBranches: () => Promise.resolve([]),
    onCreateSelectedThreadBranch: () => Promise.resolve(null),
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../thread-inspector-navigation", () => ({ useReturnToThread: () => () => {} }));
vi.mock("./gitSheetComponents", () => ({
  GitActionFailure: () => null,
  SheetActionButton: (props: ActionProps) => {
    state.actions.push(props);
    return null;
  },
}));

import { GitConfirmSheet } from "./GitConfirmSheet";

function setup(refName: string | null, params: Record<string, string>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refName = refName;
  state.actions = [];
  state.ran = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(
      <GitConfirmSheet
        route={{ params: { environmentId: "environment", threadId: "thread", ...params } }}
      />,
    );
  });
  // Each render registers Continue first, then the feature branch button.
  const [continueButton, featureBranchButton] = state.actions.slice(-2);
  return {
    container,
    continueButton: continueButton!,
    featureBranchButton: featureBranchButton!,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("describes the action it runs on the branch that is checked out", async () => {
  using screen = setup("main", {
    confirmAction: "commit_push",
    branchName: "docs",
    includesCommit: "false",
    commitMessage: "from the route",
    filePaths: "a.ts,b.ts",
  });
  expect(screen.container.textContent).toContain("Commit & push to default branch?");
  expect(screen.container.textContent).toContain('commit and push changes on "main"');
  expect(screen.continueButton.label).toBe("Commit & push to main");
  await act(async () => screen.continueButton.onPress());
  await act(async () => screen.featureBranchButton.onPress());
  expect(state.ran).toEqual([
    { action: "commit_push" },
    { action: "commit_push", featureBranch: true },
  ]);
});

it.each([
  ["an action it does not confirm", "main", "commit"],
  ["no checked out branch", null, "push"],
])("runs nothing for %s", async (_case, refName, confirmAction) => {
  using screen = setup(refName, { confirmAction });
  expect(screen.continueButton.disabled).toBe(true);
  expect(screen.featureBranchButton.disabled).toBe(true);
  await act(async () => screen.continueButton.onPress());
  await act(async () => screen.featureBranchButton.onPress());
  expect(state.ran).toEqual([]);
});
